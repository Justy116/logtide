import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DigestGeneratorService } from '../../../modules/digests/generator.js';
import type { DigestJobPayload } from '../../../modules/digests/scheduler.js';

vi.mock('../../../database/reservoir.js', () => ({
  reservoir: {
    count: vi.fn(),
  },
}));

vi.mock('@logtide/core', () => ({
  hub: {
    captureLog: vi.fn(),
  },
}));

vi.mock('../../../database/connection.js', () => ({
    db: {
      selectFrom: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn(),
      executeTakeFirst: vi.fn(),
    }
}));


const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test-message-id' });
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: mockSendMail,
    })),
  },
}));


vi.mock('../../../config/index.js', () => ({
  config: {
    SMTP_HOST: 'smtp.test.com',
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    SMTP_USER: 'test@test.com',
    SMTP_PASS: 'password',
    SMTP_FROM: 'noreply@logtide.com',
    FRONTEND_URL: 'https://app.logtide.com',
  },
}));

describe('DigestGeneratorService', () => {
  let generator: DigestGeneratorService;
  let mockDb: any;
  let mockReservoir: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { reservoir } = await import('../../../database/reservoir.js');
    mockReservoir = reservoir;
    const { db } = await import('../../../database/connection.js');
    mockDb = db;

    mockDb.execute.mockReset();
    mockDb.executeTakeFirst.mockReset();
    mockReservoir.count.mockReset();
    mockSendMail.mockReset().mockResolvedValue({ messageId: 'test-message-id' });

    generator = new DigestGeneratorService();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('generateAndSendDigest', () => {
    it('should generate and send daily digest with log volume', async () => {
      const payload: DigestJobPayload = {
        organizationId: 'org_1',
        digestConfigId: 'config_1',
        frequency: 'daily',
      };

      //  organization lookup
      mockDb.executeTakeFirst.mockResolvedValueOnce({
        name: 'Test Organization',
      });

      // recipients lookup
      mockDb.execute.mockResolvedValueOnce([
        {
          email: 'user1@test.com',
          unsubscribe_token: 'token_1',
        },
        {
          email: 'user2@test.com',
          unsubscribe_token: 'token_2',
        },
      ]);

      // Mock projects query
      mockDb.execute.mockResolvedValueOnce([{ id: 'project_1' }]);

      const { reservoir } = await import('../../../database/reservoir.js');
      
      (reservoir.count as any).mockResolvedValueOnce({
        count: 15000,
      });

      (reservoir.count as any).mockResolvedValueOnce({
        count: 12000,
      });

      await generator.generateAndSendDigest(payload);

      // Verify emails were sent
      expect(mockSendMail).toHaveBeenCalledTimes(2);

      // Check first email
      const firstCall = mockSendMail.mock.calls[0][0];
      expect(firstCall.to).toBe('user1@test.com');
      expect(firstCall.subject).toContain('Daily Report');
      expect(firstCall.subject).toContain('Test Organization');
      expect(firstCall.text).toContain('15,000');
      expect(firstCall.text).toContain('+3000 (+25.0%)');
      expect(firstCall.text).toContain('token_1');

      // Check second email
      const secondCall = mockSendMail.mock.calls[1][0];
      expect(secondCall.to).toBe('user2@test.com');
      expect(secondCall.text).toContain('token_2');
    });

    it('should generate and send weekly digest', async () => {
      const payload: DigestJobPayload = {
        organizationId: 'org_1',
        digestConfigId: 'config_1',
        frequency: 'weekly',
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce({
        name: 'Test Organization',
      });

      mockDb.execute.mockResolvedValueOnce([
        {
          email: 'user@test.com',
          unsubscribe_token: 'token_1',
        },
      ]);

      // Mock projects query
      mockDb.execute.mockResolvedValueOnce([{ id: 'project_1' }]);

      const { reservoir } = await import('../../../database/reservoir.js');
      
      (reservoir.count as any).mockResolvedValueOnce({
        count: 100000,
      });

      (reservoir.count as any).mockResolvedValueOnce({
        count: 95000,
      });

      await generator.generateAndSendDigest(payload);

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const emailCall = mockSendMail.mock.calls[0][0];
      expect(emailCall.subject).toContain('Weekly Report');
      expect(emailCall.text).toContain('100,000');
      expect(emailCall.text).toContain('+5000 (+5.3%)');
    });

    it('should handle zero activity (quiet period)', async () => {
      const payload: DigestJobPayload = {
        organizationId: 'org_1',
        digestConfigId: 'config_1',
        frequency: 'daily',
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce({
        name: 'Test Organization',
      });

      mockDb.execute.mockResolvedValueOnce([
        {
          email: 'user@test.com',
          unsubscribe_token: 'token_1',
        },
      ]);

      // Mock projects query
      mockDb.execute.mockResolvedValueOnce([{ id: 'project_1' }]);

      const { reservoir } = await import('../../../database/reservoir.js');
      (reservoir.count as any).mockResolvedValueOnce({ count: 0 });
      (reservoir.count as any).mockResolvedValueOnce({ count: 0 });

      await generator.generateAndSendDigest(payload);

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const emailCall = mockSendMail.mock.calls[0][0];
      expect(emailCall.text).toContain('No activity during this period');
      expect(emailCall.text).toContain('quiet');
    });

    it('should handle negative trend (decreased activity)', async () => {
      const payload: DigestJobPayload = {
        organizationId: 'org_1',
        digestConfigId: 'config_1',
        frequency: 'daily',
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce({
        name: 'Test Organization',
      });

      mockDb.execute.mockResolvedValueOnce([
        {
          email: 'user@test.com',
          unsubscribe_token: 'token_1',
        },
      ]);

      // Mock projects query
      mockDb.execute.mockResolvedValueOnce([{ id: 'project_1' }]);

      const { reservoir } = await import('../../../database/reservoir.js');
      (reservoir.count as any).mockResolvedValueOnce({ count: 8000 });
      (reservoir.count as any).mockResolvedValueOnce({ count: 10000 });

      await generator.generateAndSendDigest(payload);

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const emailCall = mockSendMail.mock.calls[0][0];
      expect(emailCall.text).toContain('8,000');
      expect(emailCall.text).toContain('-2000 (-20.0%)');
    });

    it('should handle new activity (previous period was zero)', async () => {
      const payload: DigestJobPayload = {
        organizationId: 'org_1',
        digestConfigId: 'config_1',
        frequency: 'daily',
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce({
        name: 'Test Organization',
      });

      mockDb.execute.mockResolvedValueOnce([
        {
          email: 'user@test.com',
          unsubscribe_token: 'token_1',
        },
      ]);

      // Mock projects query
      mockDb.execute.mockResolvedValueOnce([{ id: 'project_1' }]);

      const { reservoir } = await import('../../../database/reservoir.js');
      (reservoir.count as any).mockResolvedValueOnce({ count: 5000 });
      (reservoir.count as any).mockResolvedValueOnce({ count: 0 });

      await generator.generateAndSendDigest(payload);

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const emailCall = mockSendMail.mock.calls[0][0];
      expect(emailCall.text).toContain('5,000');
      expect(emailCall.text).toContain('+5000 (new activity)');
    });

    it('should skip sending if no subscribed recipients', async () => {
      const payload: DigestJobPayload = {
        organizationId: 'org_1',
        digestConfigId: 'config_1',
        frequency: 'daily',
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce({
        name: 'Test Organization',
      });

      // No recipients
      mockDb.execute.mockResolvedValueOnce([]);

      await generator.generateAndSendDigest(payload);

      // Should not send any emails
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('should handle organization with no projects', async () => {
      const payload: DigestJobPayload = {
        organizationId: 'org_1',
        digestConfigId: 'config_1',
        frequency: 'daily',
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce({
        name: 'Test Organization',
      });

      mockDb.execute.mockResolvedValueOnce([
        {
          email: 'user@test.com',
          unsubscribe_token: 'token_1',
        },
      ]);
      mockDb.execute.mockResolvedValueOnce([]);

      await generator.generateAndSendDigest(payload);

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const emailCall = mockSendMail.mock.calls[0][0];
      expect(emailCall.text).toContain('No activity during this period');
    });

    it('should throw error if organization not found', async () => {
      const payload: DigestJobPayload = {
        organizationId: 'org_nonexistent',
        digestConfigId: 'config_1',
        frequency: 'daily',
      };

      // Organization not found
      mockDb.executeTakeFirst.mockResolvedValueOnce(undefined);

      await expect(generator.generateAndSendDigest(payload)).rejects.toThrow(
        'Organization org_nonexistent not found'
      );

      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('should include unsubscribe link in email', async () => {
      const payload: DigestJobPayload = {
        organizationId: 'org_1',
        digestConfigId: 'config_1',
        frequency: 'daily',
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce({
        name: 'Test Organization',
      });

      mockDb.execute.mockResolvedValueOnce([
        {
          email: 'user@test.com',
          unsubscribe_token: 'secure_token_abc123',
        },
      ]);
      mockDb.execute.mockResolvedValueOnce([{ id: 'project_1' }]);

      const { reservoir } = await import('../../../database/reservoir.js');
      (reservoir.count as any).mockResolvedValueOnce({ count: 1000 });
      (reservoir.count as any).mockResolvedValueOnce({ count: 900 });

      await generator.generateAndSendDigest(payload);

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const emailCall = mockSendMail.mock.calls[0][0];
      expect(emailCall.text).toContain('unsubscribe');
      expect(emailCall.text).toContain('secure_token_abc123');
      expect(emailCall.text).toContain('https://app.logtide.com/unsubscribe?token=secure_token_abc123');
    });
  });
});
