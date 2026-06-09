import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../config/index.js', () => ({
  config: { MONITOR_ALLOW_PRIVATE_TARGETS: false, WEBHOOK_REQUEST_TIMEOUT_MS: 10000 },
}));

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock('../../../utils/ssrf-guard.js', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/ssrf-guard.js')>(
    '../../../utils/ssrf-guard.js'
  );
  return { ...actual, safeFetch: safeFetchMock };
});

const hooksMock = vi.hoisted(() => ({ hasHandlers: vi.fn(() => false), run: vi.fn() }));
vi.mock('../../../hooks/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/index.js')>(
    '../../../hooks/index.js'
  );
  return { ...actual, hooks: hooksMock };
});

import { deliverOnce } from '../../../modules/webhooks/dispatcher.js';
import { SsrfBlockedError } from '../../../utils/ssrf-guard.js';
import { verifySignature } from '../../../modules/webhooks/signing.js';

beforeEach(() => {
  safeFetchMock.mockReset();
  hooksMock.hasHandlers.mockReturnValue(false);
  hooksMock.run.mockReset();
});
afterEach(() => vi.restoreAllMocks());

function okResponse(status = 200, text = 'ok') {
  return { ok: status >= 200 && status < 300, status, statusText: 'OK', text: async () => text };
}

describe('deliverOnce', () => {
  it('signs the body when a secret is provided', async () => {
    safeFetchMock.mockResolvedValue(okResponse());
    await deliverOnce({
      url: 'https://example.com/hook',
      body: { a: 1 },
      organizationId: 'org-1',
      eventType: 'alert',
      signingSecret: 'whsec_x',
    });
    const [, init] = safeFetchMock.mock.calls[0];
    const ts = Number(init.headers['X-Logtide-Timestamp']);
    const sig = init.headers['X-Logtide-Signature'].split('v1=')[1];
    expect(verifySignature('whsec_x', ts, init.body, sig)).toBe(true);
  });

  it('returns success for 2xx', async () => {
    safeFetchMock.mockResolvedValue(okResponse(204, ''));
    const r = await deliverOnce({ url: 'https://e.com', body: {}, organizationId: 'o', eventType: 'alert' });
    expect(r.success).toBe(true);
    expect(r.statusCode).toBe(204);
  });

  it('classifies 5xx as retryable and 4xx as non-retryable', async () => {
    safeFetchMock.mockResolvedValueOnce(okResponse(503, 'down'));
    const a = await deliverOnce({ url: 'https://e.com', body: {}, organizationId: 'o', eventType: 'alert' });
    expect(a.success).toBe(false);
    expect(a.retryable).toBe(true);

    safeFetchMock.mockResolvedValueOnce(okResponse(400, 'bad'));
    const b = await deliverOnce({ url: 'https://e.com', body: {}, organizationId: 'o', eventType: 'alert' });
    expect(b.retryable).toBe(false);
  });

  it('maps SSRF block to a non-retryable failure', async () => {
    safeFetchMock.mockRejectedValue(new SsrfBlockedError('blocked'));
    const r = await deliverOnce({ url: 'http://169.254.169.254', body: {}, organizationId: 'o', eventType: 'alert' });
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.error).toMatch(/private\/internal/);
  });

  it('treats hook rejection as a non-retryable failure', async () => {
    const { HookRejectionError } = await import('../../../hooks/index.js');
    hooksMock.hasHandlers.mockReturnValue(true);
    hooksMock.run.mockRejectedValue(new HookRejectionError('nope'));
    const r = await deliverOnce({ url: 'https://e.com', body: {}, organizationId: 'o', eventType: 'alert' });
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(false);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});
