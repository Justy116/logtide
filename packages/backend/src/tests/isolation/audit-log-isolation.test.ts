import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import { build } from '../../server.js';
import { truncateAllTables } from '../helpers/index.js';
import { createTestSession } from '../helpers/auth.js';
import { createIsolatedTenants } from './helpers.js';
import { db } from '../../database/index.js';

async function sessionHeader(userId: string) {
  const session = await createTestSession(userId);
  return { Authorization: `Bearer ${session.token}` };
}

// Directly insert an audit log entry (bypasses the async buffer used in production)
async function seedAuditEntry(orgId: string, userId: string, action: string) {
  await db
    .insertInto('audit_log')
    .values({
      organization_id: orgId,
      user_id: userId,
      user_email: 'seed@test.com',
      action,
      category: 'config_change',
      resource_type: 'test',
      resource_id: null,
      ip_address: null,
      user_agent: null,
      metadata: null,
    })
    .execute();
}

describe('Tenant isolation - audit log', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('GET /api/v1/audit-log returns only own org entries', async () => {
    const t = await createIsolatedTenants();

    await seedAuditEntry(t.orgA.id, t.orgA.ownerUserId, 'action_for_org_a');
    await seedAuditEntry(t.orgB.id, t.orgB.ownerUserId, 'action_for_org_b');

    const headers = await sessionHeader(t.orgA.ownerUserId);
    const res = await request(app.server)
      .get('/api/v1/audit-log')
      .query({ organizationId: t.orgA.id })
      .set(headers)
      .expect(200);

    const actions: string[] = res.body.entries.map((e: any) => e.action);
    expect(actions).toContain('action_for_org_a');
    expect(actions).not.toContain('action_for_org_b');
  });

  it('org B user cannot read org A audit log', async () => {
    const t = await createIsolatedTenants();
    await seedAuditEntry(t.orgA.id, t.orgA.ownerUserId, 'secret_action_a');

    const headersB = await sessionHeader(t.orgB.ownerUserId);
    const res = await request(app.server)
      .get('/api/v1/audit-log')
      .query({ organizationId: t.orgA.id })
      .set(headersB);

    // Must be 403 - B user is not admin of org A
    expect(res.status).toBe(403);
  });

  it('org A user cannot read org B audit log', async () => {
    const t = await createIsolatedTenants();
    await seedAuditEntry(t.orgB.id, t.orgB.ownerUserId, 'secret_action_b');

    const headersA = await sessionHeader(t.orgA.ownerUserId);
    const res = await request(app.server)
      .get('/api/v1/audit-log')
      .query({ organizationId: t.orgB.id })
      .set(headersA);

    expect(res.status).toBe(403);
  });

  it('audit log pagination does not leak cross-org entries', async () => {
    const t = await createIsolatedTenants();

    // Seed 3 entries for A, 3 for B
    for (let i = 0; i < 3; i++) {
      await seedAuditEntry(t.orgA.id, t.orgA.ownerUserId, `action_a_${i}`);
      await seedAuditEntry(t.orgB.id, t.orgB.ownerUserId, `action_b_${i}`);
    }

    const headersA = await sessionHeader(t.orgA.ownerUserId);
    const res = await request(app.server)
      .get('/api/v1/audit-log')
      .query({ organizationId: t.orgA.id, limit: 10 })
      .set(headersA)
      .expect(200);

    const actions: string[] = res.body.entries.map((e: any) => e.action);
    for (const a of actions) {
      expect(a).not.toMatch(/action_b_/);
    }
    expect(res.body.total).toBe(3);
  });
});
