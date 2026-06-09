import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../database/index.js';
import { createTestOrganization } from '../../helpers/factories.js';
import { webhookDeliveryService } from '../../../modules/webhooks/service.js';

describe('webhookDeliveryService', () => {
  let orgId: string;
  beforeEach(async () => {
    const org = await createTestOrganization({});
    orgId = org.id;
  });

  it('creates a pending delivery', async () => {
    const d = await webhookDeliveryService.createDelivery({
      organizationId: orgId,
      eventType: 'alert',
      eventId: 'evt-1',
      url: 'https://e.com/hook',
      maxAttempts: 5,
      metadata: { foo: 'bar' },
    });
    expect(d.status).toBe('pending');
    expect(d.attempt_count).toBe(0);
  });

  it('records attempts and prunes beyond the log limit', async () => {
    const d = await webhookDeliveryService.createDelivery({
      organizationId: orgId, eventType: 'alert', eventId: 'evt-2', url: 'https://e.com/hook', maxAttempts: 5,
    });
    for (let i = 1; i <= 5; i++) {
      await webhookDeliveryService.recordAttempt(d.id, {
        attemptNumber: i, statusCode: 500, durationMs: 10, error: 'boom', responseExcerpt: 'x',
      }, 3); // keep last 3
    }
    const attempts = await db.selectFrom('webhook_delivery_attempts')
      .selectAll().where('delivery_id', '=', d.id).execute();
    expect(attempts.length).toBe(3);
  });

  it('transitions status and lists by status', async () => {
    const d = await webhookDeliveryService.createDelivery({
      organizationId: orgId, eventType: 'alert', eventId: 'evt-3', url: 'https://e.com', maxAttempts: 5,
    });
    await webhookDeliveryService.markDead(d.id, 'gave up');
    const dead = await webhookDeliveryService.listDeliveries(orgId, { status: 'dead', limit: 50, offset: 0 });
    expect(dead.map((x) => x.id)).toContain(d.id);
  });

  it('replays a dead delivery back to pending', async () => {
    const d = await webhookDeliveryService.createDelivery({
      organizationId: orgId, eventType: 'alert', eventId: 'evt-4', url: 'https://e.com', maxAttempts: 5,
    });
    await webhookDeliveryService.markDead(d.id, 'gave up');
    const reset = await webhookDeliveryService.resetForReplay(d.id);
    expect(reset?.status).toBe('pending');
    expect(reset?.attempt_count).toBe(0);
  });
});
