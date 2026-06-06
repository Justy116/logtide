import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { build } from '../../../server.js';
import { db } from '../../../database/index.js';
import { capabilities } from '../../../capabilities/index.js';
import { createTestContext } from '../../helpers/factories.js';

async function createTestSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  await db
    .insertInto('sessions')
    .values({ user_id: userId, token, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) })
    .execute();
  return token;
}

describe('global handler surfaces capability error code', () => {
  let app: FastifyInstance;
  let orgId: string;
  let projectId: string;
  let token: string;

  beforeAll(async () => {
    app = await build();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    await db.deleteFrom('alert_rules').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;
    token = await createTestSession(ctx.user.id);
    capabilities.invalidate(orgId);

    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'alerts.max_rules', enabled: null, limit_value: 0 })
      .execute();
    capabilities.invalidate(orgId);
  });

  it('returns 403 with the capability code when the cap is 0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/alerts',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        organizationId: orgId,
        projectId,
        name: 'r1',
        level: ['error'],
        threshold: 5,
        timeWindow: 10,
        emailRecipients: ['test@example.com'],
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload);
    expect(body.code).toBe('capability.alerts.max_rules.limit_reached');
  });
});
