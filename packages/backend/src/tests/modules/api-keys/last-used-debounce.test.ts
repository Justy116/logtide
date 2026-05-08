import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiKeysService } from '../../../modules/api-keys/service.js';
import { db } from '../../../database/connection.js';
import { CacheManager } from '../../../utils/cache.js';

vi.mock('../../../database/connection.js', () => ({
  db: {
    selectFrom: vi.fn(),
    updateTable: vi.fn(),
    insertInto: vi.fn(),
  },
}));

vi.mock('../../../utils/cache.js', () => ({
  CacheManager: {
    apiKeyKey: vi.fn((h) => `api_key:${h}`),
    get: vi.fn(),
    set: vi.fn(),
    invalidateApiKey: vi.fn(),
  },
  CACHE_TTL: { API_KEY: 60 },
}));

describe('ApiKeysService - last_used debounce', () => {
  let service: ApiKeysService;
  let updateCount = 0;
  let updateExecuteMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    updateCount = 0;
    updateExecuteMock = vi.fn(async () => {
      updateCount++;
    });

    // Fluent chain: .updateTable().set().where().execute()
    (db.updateTable as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      set: () => ({ where: () => ({ execute: updateExecuteMock }) }),
    }));

    // Cache hit returns a valid cached api key
    (CacheManager.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      keyId: 'key-1',
      projectId: 'proj-1',
      organizationId: 'org-1',
      type: 'full',
      allowedOrigins: null,
    });

    service = new ApiKeysService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes on first verification', async () => {
    await service.verifyApiKey('lp_test');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(updateCount).toBe(1);
  });

  it('skips writes within 60s window for same key', async () => {
    await service.verifyApiKey('lp_test');
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(30_000); // 30s later
    await service.verifyApiKey('lp_test');
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(20_000); // 50s total
    await service.verifyApiKey('lp_test');
    await vi.advanceTimersByTimeAsync(0);

    expect(updateCount).toBe(1);
  });

  it('writes again after 60s window passes', async () => {
    await service.verifyApiKey('lp_test');
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(61_000); // 61s later
    await service.verifyApiKey('lp_test');
    await vi.advanceTimersByTimeAsync(0);

    expect(updateCount).toBe(2);
  });

  it('does not block writes for different keys', async () => {
    (CacheManager.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      keyId: 'key-A',
      projectId: 'p',
      organizationId: 'o',
      type: 'full',
      allowedOrigins: null,
    });
    await service.verifyApiKey('lp_a');
    await vi.advanceTimersByTimeAsync(0);

    (CacheManager.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      keyId: 'key-B',
      projectId: 'p',
      organizationId: 'o',
      type: 'full',
      allowedOrigins: null,
    });
    await service.verifyApiKey('lp_b');
    await vi.advanceTimersByTimeAsync(0);

    expect(updateCount).toBe(2);
  });
});
