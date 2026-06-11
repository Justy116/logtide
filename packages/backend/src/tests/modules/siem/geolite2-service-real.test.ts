import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Tests against the real GeoLite2Service class (not a mock wrapper).
 * We mock fs + @maxmind/geoip2-node so no disk or DB file is needed.
 */

// Hoist mock factories so vi.mock closures can reference them
const { mockExistsSync, mockMkdirSync, mockStatSync, mockWriteFileSync, mockRenameSync, mockRmSync } =
  vi.hoisted(() => ({
    mockExistsSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockStatSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockRenameSync: vi.fn(),
    mockRmSync: vi.fn(),
  }));

const { mockReaderOpen, mockReaderCity } = vi.hoisted(() => ({
  mockReaderOpen: vi.fn(),
  mockReaderCity: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    statSync: mockStatSync,
    writeFileSync: mockWriteFileSync,
    renameSync: mockRenameSync,
    rmSync: mockRmSync,
  },
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  statSync: mockStatSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
  rmSync: mockRmSync,
}));

vi.mock('@maxmind/geoip2-node', () => ({
  Reader: {
    open: mockReaderOpen,
  },
}));

import { geoLite2Service } from '../../../modules/siem/geolite2-service.js';

// Helper to reset private fields between tests
function resetService() {
  const s = geoLite2Service as unknown as Record<string, unknown>;
  s['reader'] = null;
  s['lastUpdate'] = null;
  s['isUpdating'] = false;
  s['warnedNotLoaded'] = false;
}

function injectReader(readerObj: unknown) {
  const s = geoLite2Service as unknown as Record<string, unknown>;
  s['reader'] = readerObj;
  s['lastUpdate'] = new Date();
}

describe('GeoLite2Service (real module)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // isReady / getInfo before initialization
  // -------------------------------------------------------------------------
  describe('isReady', () => {
    it('returns false when reader is null', () => {
      expect(geoLite2Service.isReady()).toBe(false);
    });

    it('returns true after reader is injected', () => {
      injectReader({ city: mockReaderCity });
      expect(geoLite2Service.isReady()).toBe(true);
    });
  });

  describe('getInfo', () => {
    it('returns ready=false and lastUpdate=null before init', () => {
      const info = geoLite2Service.getInfo();
      expect(info.ready).toBe(false);
      expect(info.lastUpdate).toBeNull();
      expect(typeof info.path).toBe('string');
    });

    it('returns ready=true and lastUpdate set after reader injected', () => {
      injectReader({ city: mockReaderCity });
      const info = geoLite2Service.getInfo();
      expect(info.ready).toBe(true);
      expect(info.lastUpdate).toBeInstanceOf(Date);
    });
  });

  // -------------------------------------------------------------------------
  // needsUpdate
  // -------------------------------------------------------------------------
  describe('needsUpdate', () => {
    it('returns true when lastUpdate is null', () => {
      expect(geoLite2Service.needsUpdate()).toBe(true);
    });

    it('returns false when lastUpdate is recent', () => {
      injectReader({ city: mockReaderCity });
      expect(geoLite2Service.needsUpdate()).toBe(false);
    });

    it('returns true when lastUpdate is older than 24 hours', () => {
      injectReader({ city: mockReaderCity });
      (geoLite2Service as unknown as Record<string, unknown>)['lastUpdate'] = new Date(
        Date.now() - 25 * 60 * 60 * 1000
      );
      expect(geoLite2Service.needsUpdate()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // lookup
  // -------------------------------------------------------------------------
  describe('lookup', () => {
    it('returns null and warns once when reader not loaded', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const r1 = geoLite2Service.lookup('8.8.8.8');
      const r2 = geoLite2Service.lookup('8.8.8.8');
      expect(r1).toBeNull();
      expect(r2).toBeNull();
      // warning fires only once (warnedNotLoaded guard)
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/not loaded/i);
    });

    it('returns geo data from reader when loaded', () => {
      mockReaderCity.mockReturnValue({
        country: { names: { en: 'United States' }, isoCode: 'US' },
        city: { names: { en: 'Mountain View' } },
        location: { latitude: 37.386, longitude: -122.0838, timeZone: 'America/Los_Angeles', accuracyRadius: 1000 },
        subdivisions: [{ names: { en: 'California' } }],
        postal: { code: '94035' },
      });
      injectReader({ city: mockReaderCity });

      const result = geoLite2Service.lookup('8.8.8.8');
      expect(result).not.toBeNull();
      expect(result?.country).toBe('United States');
      expect(result?.countryCode).toBe('US');
      expect(result?.city).toBe('Mountain View');
      expect(result?.latitude).toBe(37.386);
      expect(result?.longitude).toBe(-122.0838);
      expect(result?.timezone).toBe('America/Los_Angeles');
      expect(result?.accuracy).toBe(1000);
      expect(result?.subdivision).toBe('California');
      expect(result?.postalCode).toBe('94035');
    });

    it('returns null when reader throws (private/invalid IP)', () => {
      mockReaderCity.mockImplementation(() => { throw new Error('not found'); });
      injectReader({ city: mockReaderCity });

      expect(geoLite2Service.lookup('192.168.1.1')).toBeNull();
    });

    it('handles missing optional fields in reader result', () => {
      mockReaderCity.mockReturnValue({
        country: null,
        city: null,
        location: null,
        subdivisions: null,
        postal: null,
      });
      injectReader({ city: mockReaderCity });

      const result = geoLite2Service.lookup('1.2.3.4');
      expect(result).not.toBeNull();
      expect(result?.country).toBe('Unknown');
      expect(result?.countryCode).toBe('XX');
      expect(result?.city).toBeNull();
      expect(result?.latitude).toBe(0);
      expect(result?.longitude).toBe(0);
      expect(result?.timezone).toBeNull();
      expect(result?.accuracy).toBeNull();
      expect(result?.subdivision).toBeNull();
      expect(result?.postalCode).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // lookupBatch
  // -------------------------------------------------------------------------
  describe('lookupBatch', () => {
    it('returns results for all IPs including null for unknowns', () => {
      mockReaderCity.mockImplementation((ip: string) => {
        if (ip === '8.8.8.8') {
          return {
            country: { names: { en: 'United States' }, isoCode: 'US' },
            city: null,
            location: { latitude: 37, longitude: -97, timeZone: null, accuracyRadius: null },
            subdivisions: null,
            postal: null,
          };
        }
        throw new Error('not found');
      });
      injectReader({ city: mockReaderCity });

      const results = geoLite2Service.lookupBatch(['8.8.8.8', '192.168.1.1']);
      expect(results['8.8.8.8']?.country).toBe('United States');
      expect(results['192.168.1.1']).toBeNull();
    });

    it('returns empty object for empty array', () => {
      injectReader({ city: mockReaderCity });
      expect(Object.keys(geoLite2Service.lookupBatch([]))).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // initialize - db exists branch
  // -------------------------------------------------------------------------
  describe('initialize', () => {
    it('loads db when file already exists', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ mtime: new Date() });
      mockReaderOpen.mockResolvedValue({ city: mockReaderCity });

      const ok = await geoLite2Service.initialize();
      expect(ok).toBe(true);
      expect(geoLite2Service.isReady()).toBe(true);
    });

    it('creates dir and downloads when dir does not exist', async () => {
      mockExistsSync
        .mockReturnValueOnce(false) // dir check
        .mockReturnValueOnce(false) // file check
        .mockReturnValue(false);    // further checks

      const mockRead = vi.fn()
        .mockResolvedValueOnce({ done: false, value: Buffer.from('data') })
        .mockResolvedValueOnce({ done: true, value: undefined });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: { getReader: () => ({ read: mockRead }) },
      });

      // After download: file still doesn't exist -> loadDatabase fails
      const ok = await geoLite2Service.initialize();
      expect(ok).toBe(false);
      expect(mockMkdirSync).toHaveBeenCalled();
    });

    it('returns false when download fails and file missing', async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // dir exists
        .mockReturnValueOnce(false); // file missing -> trigger download

      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      const ok = await geoLite2Service.initialize();
      expect(ok).toBe(false);
    });

    it('returns false when loadDatabase fails (Reader.open throws)', async () => {
      mockExistsSync.mockReturnValue(true); // dir + file exist
      mockReaderOpen.mockRejectedValue(new Error('bad mmdb'));

      const ok = await geoLite2Service.initialize();
      expect(ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // downloadDatabase
  // -------------------------------------------------------------------------
  describe('downloadDatabase', () => {
    it('returns false and skips if already updating', async () => {
      (geoLite2Service as unknown as Record<string, unknown>)['isUpdating'] = true;
      const ok = await geoLite2Service.downloadDatabase();
      expect(ok).toBe(false);
    });

    it('downloads, writes, renames and reloads successfully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ mtime: new Date() });
      mockReaderOpen.mockResolvedValue({ city: mockReaderCity });

      const mockRead = vi.fn()
        .mockResolvedValueOnce({ done: false, value: Buffer.from('mmdb bytes') })
        .mockResolvedValueOnce({ done: true, value: undefined });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: { getReader: () => ({ read: mockRead }) },
      });

      const ok = await geoLite2Service.downloadDatabase();
      expect(ok).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockRenameSync).toHaveBeenCalled();
    });

    it('returns false when fetch response is not ok', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
      mockExistsSync.mockReturnValue(false);

      const ok = await geoLite2Service.downloadDatabase();
      expect(ok).toBe(false);
    });

    it('returns false when response body is null', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, body: null });
      mockExistsSync.mockReturnValue(false);

      const ok = await geoLite2Service.downloadDatabase();
      expect(ok).toBe(false);
    });

    it('cleans up temp file on error', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Error' });
      mockExistsSync.mockReturnValue(true); // temp file exists

      await geoLite2Service.downloadDatabase();
      expect(mockRmSync).toHaveBeenCalled();
    });
  });
});
