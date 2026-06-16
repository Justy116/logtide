import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// $lib/config pulls in $app/environment (a SvelteKit virtual module that does
// not resolve under plain vitest), so both helpers are mocked at module level.
vi.mock('$lib/config', () => ({
  getApiBaseUrl: () => '/api/v1',
}));
vi.mock('$lib/utils/auth', () => ({
  getAuthToken: () => null,
}));

import { getAuditLog } from './audit-log';

describe('getAuditLog', () => {
  let capturedUrl: string | null = null;

  beforeEach(() => {
    capturedUrl = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ entries: [], total: 0 }),
      };
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes actorType and outcome when provided', async () => {
    await getAuditLog({
      organizationId: 'org-1',
      actorType: 'apiKey',
      outcome: 'failure',
      from: '2026-01-01T00:00:00Z',
    });

    expect(capturedUrl).not.toBeNull();
    const url = new URL(capturedUrl!, 'http://localhost');
    expect(url.searchParams.get('actorType')).toBe('apiKey');
    expect(url.searchParams.get('outcome')).toBe('failure');
    expect(url.searchParams.get('from')).toBe('2026-01-01T00:00:00Z');
    expect(url.searchParams.get('organizationId')).toBe('org-1');
  });

  it('omits actorType and outcome when not provided', async () => {
    await getAuditLog({
      organizationId: 'org-1',
    });

    expect(capturedUrl).not.toBeNull();
    const url = new URL(capturedUrl!, 'http://localhost');
    expect(url.searchParams.has('actorType')).toBe(false);
    expect(url.searchParams.has('outcome')).toBe(false);
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.has('to')).toBe(false);
  });

  it('returns the parsed response', async () => {
    const mockEntries = [{ id: 'e1' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ entries: mockEntries, total: 1 }),
    })));

    const result = await getAuditLog({ organizationId: 'org-1' });
    expect(result.entries).toEqual(mockEntries);
    expect(result.total).toBe(1);
  });
});
