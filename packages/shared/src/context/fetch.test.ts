import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithContext } from './fetch.js';
import { withContext } from './test-helpers.js';

describe('fetchWithContext', () => {
  let originalFetch: typeof globalThis.fetch;
  let lastInit: RequestInit | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input, init) => {
      lastInit = init;
      return new Response('ok');
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    lastInit = undefined;
  });

  it('passes through unchanged when no context', async () => {
    await fetchWithContext('https://x.test', { method: 'POST' });
    const headers = new Headers(lastInit!.headers);
    expect(headers.get('X-Logtide-Request-Id')).toBeNull();
  });

  it('injects X-Logtide-Request-Id when context is set', async () => {
    await withContext({ requestId: 'req-42' }, async () => {
      await fetchWithContext('https://x.test');
    });
    const headers = new Headers(lastInit!.headers);
    expect(headers.get('X-Logtide-Request-Id')).toBe('req-42');
  });

  it('does not overwrite an explicit header from caller', async () => {
    await withContext({ requestId: 'req-42' }, async () => {
      await fetchWithContext('https://x.test', {
        headers: { 'X-Logtide-Request-Id': 'override' },
      });
    });
    const headers = new Headers(lastInit!.headers);
    expect(headers.get('X-Logtide-Request-Id')).toBe('override');
  });
});
