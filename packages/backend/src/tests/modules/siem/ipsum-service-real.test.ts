import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Tests against the real IpsumService class (not a mock wrapper).
 * We mock fs and global.fetch so no network or disk access is needed.
 */

const {
  mockExistsSync,
  mockMkdirSync,
  mockStatSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockRenameSync,
  mockRmSync,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockRmSync: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    statSync: mockStatSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    renameSync: mockRenameSync,
    rmSync: mockRmSync,
  },
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  statSync: mockStatSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
  rmSync: mockRmSync,
}));

import { ipsumService } from '../../../modules/siem/ipsum-service.js';

function resetService() {
  const s = ipsumService as unknown as Record<string, unknown>;
  // @ts-expect-error accessing private field
  (ipsumService as unknown as { ipDatabase: Map<string, number> }).ipDatabase.clear();
  s['lastUpdate'] = null;
  s['isUpdating'] = false;
  s['isReady'] = false;
}

const SAMPLE_IPSUM_CONTENT = [
  '# IPsum threat intelligence',
  '# Comment line',
  '',
  '1.2.3.4\t5',
  '5.6.7.8\t2',
  '9.10.11.12\t1',
  '13.14.15.16\t0',
].join('\n');

describe('IpsumService (real module)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // ready / getInfo before initialization
  // -------------------------------------------------------------------------
  describe('ready', () => {
    it('returns false before init', () => {
      expect(ipsumService.ready()).toBe(false);
    });
  });

  describe('getInfo', () => {
    it('returns ready=false, lastUpdate=null, totalIps=0 before init', () => {
      const info = ipsumService.getInfo();
      expect(info.ready).toBe(false);
      expect(info.lastUpdate).toBeNull();
      expect(info.totalIps).toBe(0);
      expect(typeof info.path).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // needsUpdate
  // -------------------------------------------------------------------------
  describe('needsUpdate', () => {
    it('returns true when lastUpdate is null', () => {
      expect(ipsumService.needsUpdate()).toBe(true);
    });

    it('returns false when updated recently', () => {
      (ipsumService as unknown as Record<string, unknown>)['lastUpdate'] = new Date();
      expect(ipsumService.needsUpdate()).toBe(false);
    });

    it('returns true when older than 24 hours', () => {
      (ipsumService as unknown as Record<string, unknown>)['lastUpdate'] = new Date(
        Date.now() - 25 * 60 * 60 * 1000
      );
      expect(ipsumService.needsUpdate()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // checkIp (when db is populated via initialize)
  // -------------------------------------------------------------------------
  describe('checkIp after successful initialize', () => {
    beforeEach(async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(SAMPLE_IPSUM_CONTENT);
      mockStatSync.mockReturnValue({ mtime: new Date() });
      await ipsumService.initialize();
    });

    it('returns clean for unknown IP', () => {
      const result = ipsumService.checkIp('192.168.1.1');
      expect(result.reputation).toBe('clean');
      expect(result.score).toBe(0);
      expect(result.source).toBe('IPsum');
      expect(result.lastChecked).toBeInstanceOf(Date);
    });

    it('returns clean for score 0', () => {
      expect(ipsumService.checkIp('13.14.15.16').reputation).toBe('clean');
    });

    it('returns suspicious for score 1', () => {
      const r = ipsumService.checkIp('9.10.11.12');
      expect(r.reputation).toBe('suspicious');
      expect(r.score).toBe(1);
    });

    it('returns suspicious for score 2', () => {
      const r = ipsumService.checkIp('5.6.7.8');
      expect(r.reputation).toBe('suspicious');
      expect(r.score).toBe(2);
    });

    it('returns malicious for score >= 3', () => {
      const r = ipsumService.checkIp('1.2.3.4');
      expect(r.reputation).toBe('malicious');
      expect(r.score).toBe(5);
    });

    it('returns correct info after load', () => {
      const info = ipsumService.getInfo();
      expect(info.ready).toBe(true);
      expect(info.totalIps).toBe(4); // 4 non-comment non-empty lines parsed
      expect(info.lastUpdate).toBeInstanceOf(Date);
    });

    it('ready() returns true after init', () => {
      expect(ipsumService.ready()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // checkIpBatch
  // -------------------------------------------------------------------------
  describe('checkIpBatch', () => {
    beforeEach(async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(SAMPLE_IPSUM_CONTENT);
      mockStatSync.mockReturnValue({ mtime: new Date() });
      await ipsumService.initialize();
    });

    it('checks multiple IPs and returns correct reputations', () => {
      const results = ipsumService.checkIpBatch(['1.2.3.4', '5.6.7.8', '99.99.99.99']);
      expect(results['1.2.3.4'].reputation).toBe('malicious');
      expect(results['5.6.7.8'].reputation).toBe('suspicious');
      expect(results['99.99.99.99'].reputation).toBe('clean');
    });

    it('returns empty object for empty array', () => {
      expect(Object.keys(ipsumService.checkIpBatch([]))).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // initialize paths
  // -------------------------------------------------------------------------
  describe('initialize', () => {
    it('creates dir when missing, downloads when file missing, returns false on fetch error', async () => {
      mockExistsSync
        .mockReturnValueOnce(false) // dir missing
        .mockReturnValueOnce(false); // file missing
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

      const ok = await ipsumService.initialize();
      expect(ok).toBe(false);
      expect(mockMkdirSync).toHaveBeenCalled();
    });

    it('loads db when dir and file both exist', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(SAMPLE_IPSUM_CONTENT);
      mockStatSync.mockReturnValue({ mtime: new Date() });

      const ok = await ipsumService.initialize();
      expect(ok).toBe(true);
    });

    it('returns false when readFileSync throws during load', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => { throw new Error('disk error'); });

      const ok = await ipsumService.initialize();
      expect(ok).toBe(false);
    });

    it('handles db with only comments and blank lines', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('# comment\n\n# another comment\n');
      mockStatSync.mockReturnValue({ mtime: new Date() });

      const ok = await ipsumService.initialize();
      expect(ok).toBe(true);
      expect(ipsumService.getInfo().totalIps).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // downloadDatabase
  // -------------------------------------------------------------------------
  describe('downloadDatabase', () => {
    it('returns false if already updating', async () => {
      (ipsumService as unknown as Record<string, unknown>)['isUpdating'] = true;
      const ok = await ipsumService.downloadDatabase();
      expect(ok).toBe(false);
    });

    it('downloads, writes, renames and reloads successfully', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(SAMPLE_IPSUM_CONTENT),
      });
      // After rename: file exists -> loadDatabase succeeds
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(SAMPLE_IPSUM_CONTENT);
      mockStatSync.mockReturnValue({ mtime: new Date() });

      const ok = await ipsumService.downloadDatabase();
      expect(ok).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockRenameSync).toHaveBeenCalled();
    });

    it('returns false when fetch response is not ok', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
      mockExistsSync.mockReturnValue(false);

      const ok = await ipsumService.downloadDatabase();
      expect(ok).toBe(false);
    });

    it('cleans up temp file on error when temp exists', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Error' });
      mockExistsSync.mockReturnValue(true); // temp file exists

      await ipsumService.downloadDatabase();
      expect(mockRmSync).toHaveBeenCalled();
    });

    it('does not call rmSync if temp file does not exist on error', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Error' });
      mockExistsSync.mockReturnValue(false);

      await ipsumService.downloadDatabase();
      expect(mockRmSync).not.toHaveBeenCalled();
    });
  });
});
