import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the config with custom TTL
vi.mock('../../config/index.js', () => ({
    config: {
        CACHE_ENABLED: true,
        CACHE_TTL: 120, // Custom TTL different from default 60
    },
}));

vi.mock('../../queue/connection.js', () => ({
    getConnection: () => null,
    isRedisAvailable: () => false,
}));

describe('Cache Utilities (Custom TTL)', () => {
    let getCacheTTL: any;

    beforeEach(async () => {
        vi.resetModules();
        const module = await import('../../utils/cache.js');
        getCacheTTL = module.getCacheTTL;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('getCacheTTL', () => {
        it('applies the global override to the query cache TTL', () => {
            // CACHE_TTL.QUERY is 60; the override (120) tunes the query cache.
            expect(getCacheTTL(60)).toBe(120);
        });

        it('does not clamp semantic TTLs (sessions, settings, etc.)', () => {
            // A 5-minute semantic TTL must be preserved, not clamped to the override.
            expect(getCacheTTL(300)).toBe(300);
            // A 30-minute session TTL must be preserved.
            expect(getCacheTTL(1800)).toBe(1800);
        });
    });
});
