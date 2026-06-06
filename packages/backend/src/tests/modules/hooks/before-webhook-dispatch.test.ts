import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookProvider } from '../../../modules/notification-channels/providers/webhook-provider.js';
import type { NotificationContext } from '../../../modules/notification-channels/providers/interface.js';
import { hooks, HookRejectionError } from '../../../hooks/index.js';

// safeFetch normally resolves DNS + validates; in tests delegate straight to
// the mocked global.fetch so header/payload assertions hold without network.
vi.mock('../../../utils/ssrf-guard.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    safeFetch: (url: string, init: any) => (global.fetch as any)(url, init),
  };
});

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

const notificationCtx: NotificationContext = {
  organizationId: 'org-123',
  organizationName: 'Test Org',
  eventType: 'alert',
  title: 'Test Alert',
  message: 'Test message',
  channelId: 'chan-42',
};

describe('beforeWebhookDispatch hook (webhook provider)', () => {
  let provider: WebhookProvider;

  beforeEach(() => {
    hooks.clear();
    provider = new WebhookProvider();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
  });

  afterEach(() => {
    hooks.clear();
  });

  it('receives url/host/channel context and dispatch proceeds when the hook passes', async () => {
    let seen: any = null;
    hooks.register('beforeWebhookDispatch', async (ctx) => {
      seen = { url: ctx.url, targetHost: ctx.targetHost, channelId: ctx.channelId, organizationId: ctx.organizationId };
    });

    const result = await provider.send(notificationCtx, { url: 'https://example.com/hook' });
    expect(result.success).toBe(true);
    expect(seen).toEqual({
      url: 'https://example.com/hook',
      targetHost: 'example.com',
      channelId: 'chan-42',
      organizationId: 'org-123',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejection blocks the dispatch: no HTTP call, failed DeliveryResult', async () => {
    hooks.register('beforeWebhookDispatch', async () => {
      throw new HookRejectionError('policy.webhook_blocked', 'host not allowed');
    });

    const result = await provider.send(notificationCtx, { url: 'https://example.com/hook' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('host not allowed');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('an unexpectedly throwing hook also blocks the dispatch (fail-closed)', async () => {
    hooks.register('beforeWebhookDispatch', async () => {
      throw new TypeError('broken hook');
    });

    const result = await provider.send(notificationCtx, { url: 'https://example.com/hook' });
    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('mutation: injected headers and body changes reach the outbound request', async () => {
    hooks.register('beforeWebhookDispatch', async (ctx) => {
      ctx.headers['X-Compliance-Tag'] = 'audited';
      ctx.body.injected = true;
    });

    await provider.send(notificationCtx, { url: 'https://example.com/hook' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['X-Compliance-Tag']).toBe('audited');
    expect(JSON.parse(init.body).injected).toBe(true);
  });
});
