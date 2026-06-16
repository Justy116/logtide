import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db } from '../../../database/index.js';
import { adminEntitlementsRoutes } from '../../../modules/capabilities/admin-routes.js';
import { capabilities } from '../../../capabilities/index.js';
import { createTestContext, createTestUser } from '../../helpers/factories.js';

async function createTestSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  await db
    .insertInto('sessions')
    .values({ user_id: userId, token, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) })
    .execute();
  return token;
}

async function setAdmin(userId: string) {
  await db.updateTable('users').set({ is_admin: true }).where('id', '=', userId).execute();
}

describe('admin entitlements routes', () => {
  let app: FastifyInstance;
  let orgId: string;
  let adminToken: string;
  let memberToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(adminEntitlementsRoutes, { prefix: '/api/v1/admin' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    memberToken = await createTestSession(ctx.user.id);

    const admin = await createTestUser({ email: `admin-${Date.now()}@test.com` });
    await setAdmin(admin.id);
    adminToken = await createTestSession(admin.id);
    capabilities.invalidate(orgId);
  });

  it('GET returns the merged entitlement set for an org (admin)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/organizations/${orgId}/entitlements`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.entitlements['auth.sso']).toEqual({ kind: 'boolean', enabled: true });
    expect(body.entitlements['alerts.max_rules']).toEqual({ kind: 'limit', limit: null });
  });

  it('PUT upserts a boolean entitlement and invalidates cache', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/organizations/${orgId}/entitlements`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { entitlements: [{ capability: 'auth.sso', enabled: false }] },
    });
    expect(res.statusCode).toBe(200);

    const row = await db
      .selectFrom('organization_entitlements')
      .selectAll()
      .where('organization_id', '=', orgId)
      .where('capability', '=', 'auth.sso')
      .executeTakeFirst();
    expect(row?.enabled).toBe(false);

    // Cache invalidated -> facade reflects the new value
    expect(await capabilities.has(orgId, 'auth.sso')).toBe(false);
  });

  it('PUT upserts a numeric limit', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/organizations/${orgId}/entitlements`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { entitlements: [{ capability: 'alerts.max_rules', limitValue: 10 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(await capabilities.getLimit(orgId, 'alerts.max_rules')).toBe(10);
  });

  it('PUT accepts limitValue: null (unlimited) on a quota capability', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/organizations/${orgId}/entitlements`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { entitlements: [{ capability: 'ingestion.max_bytes_monthly', limitValue: null }] },
    });
    expect(res.statusCode).toBe(200);
    expect(await capabilities.getLimit(orgId, 'ingestion.max_bytes_monthly')).toBeNull();
  });

  it('PUT rejects an unknown capability name with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/organizations/${orgId}/entitlements`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { entitlements: [{ capability: 'not.a.real.cap', enabled: true }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT rejects a value-shape mismatch (enabled on a limit cap) with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/organizations/${orgId}/entitlements`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { entitlements: [{ capability: 'alerts.max_rules', enabled: true }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-admin with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/organizations/${orgId}/entitlements`,
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
