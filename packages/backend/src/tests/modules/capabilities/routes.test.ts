import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db } from '../../../database/index.js';
import { capabilitiesRoutes } from '../../../modules/capabilities/routes.js';
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

describe('GET /api/v1/capabilities', () => {
  let app: FastifyInstance;
  let orgId: string;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(capabilitiesRoutes, { prefix: '/api/v1/capabilities' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    token = await createTestSession(ctx.user.id);
    capabilities.invalidate(orgId);
  });

  it('returns the merged capability set for the org', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/capabilities?organizationId=${orgId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.capabilities['auth.sso']).toEqual({ kind: 'boolean', enabled: true });
    expect(body.capabilities['alerts.max_rules']).toEqual({ kind: 'limit', limit: null });
    expect(body.capabilities['ingestion.max_bytes_monthly']).toEqual({ kind: 'quota', limit: null });
  });

  it('reflects an admin override in the merged set', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'alerts.max_rules', enabled: null, limit_value: 7 })
      .execute();
    capabilities.invalidate(orgId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/capabilities?organizationId=${orgId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = JSON.parse(res.payload);
    expect(body.capabilities['alerts.max_rules']).toEqual({ kind: 'limit', limit: 7 });
  });

  it('returns 400 when organizationId is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/capabilities`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-member with 403', async () => {
    const other = await createTestContext();
    const otherToken = await createTestSession(other.user.id);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/capabilities?organizationId=${orgId}`,
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
