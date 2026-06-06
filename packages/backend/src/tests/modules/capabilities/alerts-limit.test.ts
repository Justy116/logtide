import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db } from '../../../database/index.js';
import { alertsRoutes } from '../../../modules/alerts/index.js';
import { contextPlugin } from '../../../context/index.js';
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

function alertBody(orgId: string, projectId: string, name: string) {
  return {
    organizationId: orgId,
    projectId,
    name,
    level: ['error'],
    threshold: 5,
    timeWindow: 10,
    emailRecipients: ['test@example.com'],
  };
}

describe('alerts.max_rules enforcement', () => {
  let app: FastifyInstance;
  let orgId: string;
  let projectId: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    // contextPlugin establishes context in onRequest (organizationId starts null).
    // The route handler updates it after body parse before assertWithinLimit.
    await app.register(contextPlugin);
    await app.register(alertsRoutes, { prefix: '/api/v1/alerts' });
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
    userId = ctx.user.id;
    token = await createTestSession(userId);
    capabilities.invalidate(orgId);
  });

  it('allows creating rules when the limit is unlimited (default)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/alerts',
      headers: { Authorization: `Bearer ${token}` },
      payload: alertBody(orgId, projectId, 'rule-1'),
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 403 when creating the (N+1)th rule past the cap', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'alerts.max_rules', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/alerts',
      headers: { Authorization: `Bearer ${token}` },
      payload: alertBody(orgId, projectId, 'rule-1'),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/alerts',
      headers: { Authorization: `Bearer ${token}` },
      payload: alertBody(orgId, projectId, 'rule-2'),
    });
    expect(second.statusCode).toBe(403);
  });
});
