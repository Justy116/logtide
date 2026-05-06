import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DigestGeneratorService } from '../../../modules/digests/generator.js';
import { db } from '../../../database/connection.js';
import { reservoir } from '../../../database/reservoir.js';

const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test-message-id' });
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: mockSendMail,
    })),
  },
}));

describe('DigestGeneratorService Integration', () => {
  let generator: DigestGeneratorService;
  
  beforeEach(async () => {
    vi.clearAllMocks();
    generator = new DigestGeneratorService();
  });

  /**
   * Integration test that validates the digest generation flow using the reservoir abstract engine to count logs from the database.
   */
  it('should correctly count log volume using reservoir abstract engine on database', async () => {
    // Create a user first (required for organization owner_id)
    const user = await db
      .insertInto('users')
      .values({
        email: 'test@example.com',
        password_hash: 'test_hash',
        name: 'Test User',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const org = await db
      .insertInto('organizations')
      .values({
        name: 'Test Org',
        slug: 'test-org',
        owner_id: user.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    
    const project = await db
      .insertInto('projects')
      .values({
        organization_id: org.id,
        name: 'Test Project',
        slug: 'test-project',
        user_id: user.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const config = await db
      .insertInto('digest_configs')
      .values({
        organization_id: org.id,
        frequency: 'daily',
        delivery_hour: 8,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('digest_recipients')
      .values({
        organization_id: org.id,
        digest_config_id: config.id,
        email: 'digest@example.com',
        unsubscribe_token: 'test_token',
      })
      .execute();

    const now = new Date();

    // Insert logs via reservoir.ingest() to test the production path
    
    const logsToIngest = [];
    for (let i = 0; i < 150; i++) {
        const isCurrentPeriod = i < 100;
        const baseTime = isCurrentPeriod 
          ? now.getTime() - (12 * 60 * 60 * 1000)  // Start 12 hours ago
          : now.getTime() - (36 * 60 * 60 * 1000); // Start 36 hours ago
        
        // Spread logs over 10 hours with 6-minute intervals
        const logTime = new Date(baseTime + (i % 100) * 6 * 60 * 1000);
        
        logsToIngest.push({
            organizationId: org.id,  // Required for digest queries to find the logs
            projectId: project.id,
            service: 'test-service',
            level: 'info' as const,
            message: `test log ${i}`,
            time: logTime
        });
    }

    await reservoir.ingest(logsToIngest);

    await generator.generateAndSendDigest({
      organizationId: org.id,
      digestConfigId: config.id,
      frequency: 'daily',
    });

    expect(mockSendMail).toHaveBeenCalledTimes(1);

    const emailCall = mockSendMail.mock.calls[0][0];
    const emailText = emailCall.text;

    // More robust assertions that check for exact metric lines
    const currentLogCount = 100;
    const previousLogCount = 50;
    const expectedDelta = currentLogCount - previousLogCount;
    const expectedPercentChange = ((expectedDelta / previousLogCount) * 100).toFixed(1);
    
    // Extract the metrics from the email to avoid fragile substring matching
    const totalLogsMatch = emailText.match(/Total logs:\s+(\d+)/);
    const previousPeriodMatch = emailText.match(/Previous period:\s+(\d+)/);
    const trendMatch = emailText.match(/Trend:\s+([+-]\d+)\s+\(([+-][\d.]+)%\)/);
    
    expect(totalLogsMatch, 'Email should contain "Total logs" metric').toBeTruthy();
    expect(totalLogsMatch![1]).toBe(String(currentLogCount));
    
    expect(previousPeriodMatch, 'Email should contain "Previous period" metric').toBeTruthy();
    expect(previousPeriodMatch![1]).toBe(String(previousLogCount));
    
    expect(trendMatch, 'Email should contain "Trend" metric').toBeTruthy();
    expect(trendMatch![1]).toBe(`+${expectedDelta}`);
   
    expect(trendMatch![2]).toBe(`+${expectedPercentChange}`);
  });
});
