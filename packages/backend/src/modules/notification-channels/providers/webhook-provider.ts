/**
 * Webhook Notification Provider
 * Sends notifications via HTTP POST to configured URLs
 */

import type { NotificationProvider, NotificationContext, DeliveryResult } from './interface.js';
import type { WebhookChannelConfig, ChannelConfig } from '@logtide/shared';
import { deliverOnce } from '../../webhooks/index.js';

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

    const result = await deliverOnce({
      url: webhookConfig.url,
      body: this.buildPayload(context),
      organizationId: context.organizationId ?? null,
      eventType: context.eventType,
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

  async test(channelConfig: ChannelConfig): Promise<DeliveryResult> {
    return this.send(
      {
        organizationId: 'test',
        organizationName: 'Test Organization',
        eventType: 'alert',
        title: 'Test Notification',
        message: 'This is a test notification from LogTide to verify your webhook configuration.',
        severity: 'informational',
      },
      channelConfig
    );
  }

  private buildPayload(context: NotificationContext): Record<string, unknown> {
    return {
      event_type: context.eventType,
      title: context.title,
      message: context.message,
      severity: context.severity || 'informational',
      organization: {
        id: context.organizationId,
        name: context.organizationName,
      },
      link: context.link,
      timestamp: new Date().toISOString(),
      metadata: context.metadata || {},
    };
  }
}
