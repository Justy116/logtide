/**
 * Webhook Notification Provider
 * Sends notifications via HTTP POST to configured URLs
 */

import type { NotificationProvider, NotificationContext, DeliveryResult } from './interface.js';
import type { WebhookChannelConfig, ChannelConfig, WebhookEventType } from '@logtide/shared';
import { deliverOnce, buildEnvelope } from '../../webhooks/index.js';
import type { NotificationEventType } from '@logtide/shared';

/** Map a NotificationEventType to a WebhookEventType for the envelope. */
function toEnvelopeType(eventType: NotificationEventType | string): WebhookEventType {
  switch (eventType) {
    case 'alert':
    case 'anomaly':
    case 'sigma':
      return 'alert.triggered';
    case 'error':
      return 'error.detected';
    case 'monitoring':
      return 'monitor.status_changed';
    case 'incident':
      return 'incident.created';
    default:
      // Unknown or test events fall back to channel.test
      return 'channel.test';
  }
}

export class WebhookProvider implements NotificationProvider {
  readonly type = 'webhook' as const;

  async send(context: NotificationContext, channelConfig: ChannelConfig): Promise<DeliveryResult> {
    if (!this.validateConfig(channelConfig)) {
      return { success: false, error: 'Invalid webhook configuration' };
    }

    const webhookConfig = channelConfig as WebhookChannelConfig;

    // Build auth headers, then hand off to the shared deliverOnce primitive
    // (#218): it runs the beforeWebhookDispatch hook, applies the SSRF guard,
    // and signs the body. This keeps the synchronous DeliveryResult contract
    // the "Test Channel" button relies on while centralizing delivery.
    const headers: Record<string, string> = { ...(webhookConfig.headers || {}) };
    if (webhookConfig.auth) {
      if (webhookConfig.auth.type === 'bearer' && webhookConfig.auth.token) {
        headers['Authorization'] = `Bearer ${webhookConfig.auth.token}`;
      } else if (
        webhookConfig.auth.type === 'basic' &&
        webhookConfig.auth.username &&
        webhookConfig.auth.password
      ) {
        const credentials = Buffer.from(
          `${webhookConfig.auth.username}:${webhookConfig.auth.password}`
        ).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
      }
    }

    const envelopeType = toEnvelopeType(context.eventType);

    const envelope = buildEnvelope({
      type: envelopeType,
      organizationId: context.organizationId,
      projectId: null,
      data: this.buildData(context),
    });

    const result = await deliverOnce({
      url: webhookConfig.url,
      body: envelope,
      organizationId: context.organizationId ?? null,
      eventType: envelopeType,
      method: webhookConfig.method,
      headers,
      channelId: context.channelId,
    });

    if (result.success) {
      return { success: true, metadata: { statusCode: result.statusCode, url: webhookConfig.url } };
    }
    return { success: false, error: result.error };
  }

  validateConfig(config: unknown): config is WebhookChannelConfig {
    const c = config as WebhookChannelConfig;
    return (
      typeof c === 'object' &&
      c !== null &&
      typeof c.url === 'string' &&
      (c.url.startsWith('http://') || c.url.startsWith('https://'))
    );
  }

  async test(channelConfig: ChannelConfig, organizationId: string): Promise<DeliveryResult> {
    return this.send(
      {
        organizationId,
        organizationName: 'Test Organization',
        // 'test' is not in NotificationEventType; cast to trigger the default
        // branch in toEnvelopeType which maps to 'channel.test'.
        eventType: 'test' as NotificationEventType,
        title: 'Test Notification',
        message: 'This is a test notification from LogTide to verify your webhook configuration.',
        severity: 'informational',
      },
      channelConfig
    );
  }

  /** Build the per-type data object (minus event_type/timestamp which move to the envelope). */
  private buildData(context: NotificationContext): Record<string, unknown> {
    return {
      title: context.title,
      message: context.message,
      severity: context.severity || 'informational',
      organization: {
        id: context.organizationId,
        name: context.organizationName,
      },
      link: context.link,
      metadata: context.metadata || {},
    };
  }
}
