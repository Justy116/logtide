/**
 * Digest Generator Service
 *
 * Generates and sends email digest reports summarizing log activity over a period.
 */

import nodemailer from 'nodemailer';
import { db } from '../../database/connection.js';
import { reservoir } from '../../database/reservoir.js';
import { hub } from '@logtide/core';
import { config } from '../../config/index.js';
import type { DigestJobPayload } from './scheduler.js';

interface LogVolumeStats {
  currentPeriodCount: number;
  previousPeriodCount: number;
  trend: string;
}

interface DigestRecipient {
  email: string;
  unsubscribe_token: string;
}


let emailTransporter: nodemailer.Transporter | null = null;

function getEmailTransporter(): nodemailer.Transporter | null {
  if (!emailTransporter) {
    if (!config.SMTP_HOST) {
      hub.captureLog('warn', '[DigestGenerator] SMTP not configured - digest emails disabled');
      return null;
    }

    const transportOpts: Record<string, unknown> = {
      host: config.SMTP_HOST,
      port: config.SMTP_PORT || 587,
      secure: config.SMTP_SECURE || false,
    };

    if (config.SMTP_USER && config.SMTP_PASS) {
      transportOpts.auth = {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      };
    }

    emailTransporter = nodemailer.createTransport(transportOpts as nodemailer.TransportOptions);
    hub.captureLog('info', `[DigestGenerator] Email transporter configured: ${config.SMTP_HOST}:${config.SMTP_PORT}`);
  }

  return emailTransporter;
}

export class DigestGeneratorService {
  
  async generateAndSendDigest(payload: DigestJobPayload): Promise<void> {
    const { organizationId, digestConfigId, frequency } = payload;

    hub.captureLog('info', `[DigestGenerator] Generating ${frequency} digest for org ${organizationId}`);

    try {
      
      const organization = await db
        .selectFrom('organizations')
        .select(['name'])
        .where('id', '=', organizationId)
        .executeTakeFirst();

      if (!organization) {
        throw new Error(`Organization ${organizationId} not found`);
      }

      
      const recipients = await this.fetchRecipients(organizationId, digestConfigId);

      if (recipients.length === 0) {
        hub.captureLog('info', `[DigestGenerator] No subscribed recipients for org ${organizationId}, skipping`);
        return;
      }

      
      const stats = await this.calculateLogVolume(organizationId, frequency);

      
      await this.sendDigestEmails(
        recipients,
        organization.name,
        frequency,
        stats
      );

      hub.captureLog('info', `[DigestGenerator] Digest sent to ${recipients.length} recipient(s) for org ${organizationId}`);
    } catch (error: any) {
      hub.captureLog('error', `[DigestGenerator] Failed to generate digest for org ${organizationId}: ${error.message}`, { error });
      throw error;
    }
  }

  
  private async fetchRecipients(
    organizationId: string,
    digestConfigId: string
  ): Promise<DigestRecipient[]> {
    const recipients = await db
      .selectFrom('digest_recipients')
      .select(['email', 'unsubscribe_token'])
      .where('organization_id', '=', organizationId)
      .where('digest_config_id', '=', digestConfigId)
      .where('subscribed', '=', true)
      .execute();

    return recipients;
  }

  private async calculateLogVolume(
    organizationId: string,
    frequency: 'daily' | 'weekly'
  ): Promise<LogVolumeStats> {
    // Uses a 24-hour sliding window relative to execution time
    const hoursInPeriod = frequency === 'daily' ? 24 : 168; // 7 days = 168 hours

    const now = new Date();
    const currentPeriodStart = new Date(now.getTime() - hoursInPeriod * 60 * 60 * 1000);
    const previousPeriodStart = new Date(now.getTime() - hoursInPeriod * 2 * 60 * 60 * 1000);
    const previousPeriodEnd = currentPeriodStart;

    let currentPeriodCount = 0;
    let previousPeriodCount = 0;

    try {
      
      // organization-level metrics we must count logs for all projects that
      // belong to the organization and pass those project ids to the reservoir
      const projects = await db
        .selectFrom('projects')
        .select(['id'])
        .where('organization_id', '=', organizationId)
        .execute();

      const projectIds = projects.map((p) => p.id);

      // If the organization has no projects, return zero counts explicitly
      if (projectIds.length === 0) {
        const trend = this.calculateTrend(0, 0);
        return {
          currentPeriodCount: 0,
          previousPeriodCount: 0,
          trend,
        };
      } else {
        const currentPeriodResult = await reservoir.count({
          projectId: projectIds,
          from: currentPeriodStart,
          to: now,
          toExclusive: true,
        });
        currentPeriodCount = currentPeriodResult.count;

        const previousPeriodResult = await reservoir.count({
          projectId: projectIds,
          from: previousPeriodStart,
          to: previousPeriodEnd,
          toExclusive: true,
        });
        previousPeriodCount = previousPeriodResult.count;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      hub.captureLog('error', `[DigestGenerator] Log volume count failed for org ${organizationId}: ${message}`, { error });
      throw error;
    }

    const trend = this.calculateTrend(currentPeriodCount, previousPeriodCount);

    return {
      currentPeriodCount,
      previousPeriodCount,
      trend,
    };
  }

  
   //current and previous counts
   
  private calculateTrend(current: number, previous: number): string {
    if (previous === 0 && current === 0) {
      return 'no change';
    }

    if (previous === 0) {
      return `+${current} (new activity)`;
    }

    const delta = current - previous;
    const percentChange = ((delta / previous) * 100).toFixed(1);

    if (delta > 0) {
      return `+${delta} (+${percentChange}%)`;
    } else if (delta < 0) {
      return `${delta} (${percentChange}%)`;
    } else {
      return 'no change';
    }
  }

  //mail 
  private async sendDigestEmails(
    recipients: DigestRecipient[],
    organizationName: string,
    frequency: 'daily' | 'weekly',
    stats: LogVolumeStats
  ): Promise<void> {
    const transporter = getEmailTransporter();

    if (!transporter) {
      throw new Error('Email transporter not configured');
    }

    const subject = `[LogTide Digest] ${frequency === 'daily' ? 'Daily' : 'Weekly'} Report - ${organizationName}`;

    
    const emailPromises = recipients.map(async (recipient) => {
      const text = this.generatePlaintextEmail(
        organizationName,
        frequency,
        stats,
        recipient.unsubscribe_token
      );

      await transporter.sendMail({
        from: `"LogTide" <${config.SMTP_FROM || config.SMTP_USER}>`,
        to: recipient.email,
        subject,
        text,
      });

      hub.captureLog('info', `[DigestGenerator] Email sent to ${recipient.email}`);
    });

    await Promise.all(emailPromises);
  }

  //email template
  private generatePlaintextEmail(
    organizationName: string,
    frequency: 'daily' | 'weekly',
    stats: LogVolumeStats,
    unsubscribeToken: string
  ): string {
    const period = frequency === 'daily' ? 'last 24 hours' : 'last 7 days';
    const frontendUrl = this.getFrontendUrl();
    const unsubscribeUrl = `${frontendUrl}/unsubscribe?token=${unsubscribeToken}`;

    let content = `LogTide ${frequency === 'daily' ? 'Daily' : 'Weekly'} Digest\n`;
    content += `Organization: ${organizationName}\n`;
    content += `Period: ${period}\n`;
    content += `\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `\n`;

    if (stats.currentPeriodCount === 0 && stats.previousPeriodCount === 0) {
      content += ` Log Volume\n`;
      content += `\n`;
      content += `No activity during this period.\n`;
      content += `Your systems have been quiet.\n`;
    } else {
      content += ` Log Volume\n`;
      content += `\n`;
      content += `Total logs: ${stats.currentPeriodCount.toLocaleString()}\n`;
      content += `Trend: ${stats.trend}\n`;
      content += `Previous period: ${stats.previousPeriodCount.toLocaleString()}\n`;
    }

    content += `\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `\n`;
    content += `View your dashboard: ${frontendUrl}\n`;
    content += `\n`;
    content += `To unsubscribe from these reports, click:\n`;
    content += `${unsubscribeUrl}\n`;
    content += `\n`;
    content += `—\n`;
    content += `LogTide - observability for your infrastructure\n`;

    return content;
  }

  
  private getFrontendUrl(): string {
    return config.FRONTEND_URL || 'http://localhost:3000';
  }
}


export const digestGenerator = new DigestGeneratorService();
