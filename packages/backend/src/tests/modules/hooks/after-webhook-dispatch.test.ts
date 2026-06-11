import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hooks } from '../../../hooks/index.js';
import type { AfterWebhookDispatchContext } from '../../../hooks/index.js';

// Route safeFetch straight to the mocked global.fetch (no DNS/SSRF in tests)
vi.mock('../../../config/index.js', () => ({
  config: { MONITOR_ALLOW_PRIVATE_TARGETS: false, WEBHOOK_REQUEST_TIMEOUT_MS: 10000 },
}));

vi.mock('../../../utils/ssrf-guard.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    safeFetch: (url: string, init: any) => (global.fetch as any)(url, init),
  };
});

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { deliverOnce } from '../../../modules/webhooks/dispatcher.js';

const BASE_PARAMS = {
  url: 'https://example.com/hook',
  organizationId: 'org-1',
  eventType: 'alert.triggered',
  body: { id: 'evt_test', type: 'alert.triggered', version: 1 },
} as const;

describe('afterWebhookDispatch hook (deliverOnce)', () => {
  beforeEach(() => {
    hooks.clear();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => 'ok' });
  });

  afterEach(() => {
    hooks.clear();
    vi.restoreAllMocks();
  });

  it('fires with correct fields on a successful delivery', async () => {
    let captured: AfterWebhookDispatchContext | null = null;
    hooks.register('afterWebhookDispatch', async (ctx) => {
      captured = { ...ctx };
    });

    const result = await deliverOnce({ ...BASE_PARAMS });
    expect(result.success).toBe(true);

    await new Promise((r) => setTimeout(r, 10));

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(BASE_PARAMS.url);
    expect(captured!.eventType).toBe(BASE_PARAMS.eventType);
    expect(captured!.organizationId).toBe(BASE_PARAMS.organizationId);
    expect(captured!.success).toBe(true);
    expect(captured!.statusCode).toBe(200);
    expect(captured!.durationMs).toBeGreaterThanOrEqual(0);
    expect(captured!.error).toBeNull();
    expect(captured!.retryable).toBe(false);
  });

  it('fires with success=false and correct statusCode on a 500 response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error', text: async () => 'error' });

    let captured: AfterWebhookDispatchContext | null = null;
    hooks.register('afterWebhookDispatch', async (ctx) => {
      captured = { ...ctx };
    });

    const result = await deliverOnce({ ...BASE_PARAMS });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);

    await new Promise((r) => setTimeout(r, 10));

    expect(captured!.success).toBe(false);
    expect(captured!.statusCode).toBe(500);
    expect(captured!.retryable).toBe(true);
    expect(captured!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fires even when beforeWebhookDispatch rejects (hook-rejection path)', async () => {
    const { HookRejectionError } = await import('../../../hooks/index.js');

    let afterCaptured: AfterWebhookDispatchContext | null = null;
    hooks.register('beforeWebhookDispatch', async () => {
      throw new HookRejectionError('policy.blocked', 'blocked by policy');
    });
    hooks.register('afterWebhookDispatch', async (ctx) => {
      afterCaptured = { ...ctx };
    });

    const result = await deliverOnce({ ...BASE_PARAMS });
    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 10));

    expect(afterCaptured).not.toBeNull();
    expect(afterCaptured!.success).toBe(false);
    expect(afterCaptured!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('context is frozen', async () => {
    let received: AfterWebhookDispatchContext | null = null;
    hooks.register('afterWebhookDispatch', async (ctx) => {
      received = ctx;
    });

    await deliverOnce({ ...BASE_PARAMS });
    await new Promise((r) => setTimeout(r, 10));

    expect(Object.isFrozen(received)).toBe(true);
  });

  it('a throwing afterWebhookDispatch handler does not change the DeliverOnceResult', async () => {
    hooks.register('afterWebhookDispatch', async () => {
      throw new Error('after hook crash');
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await deliverOnce({ ...BASE_PARAMS });

    await new Promise((r) => setTimeout(r, 10));

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    warn.mockRestore();
  });
});
