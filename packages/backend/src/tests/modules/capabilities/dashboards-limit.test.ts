import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db } from '../../../database/index.js';
import { customDashboardsRoutes } from '../../../modules/custom-dashboards/routes.js';
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

async function insertDashboard(organizationId: string, userId: string, n = 1, isPersonal = false) {
  const [dashboard] = await db
    .insertInto('custom_dashboards')
    .values({
      organization_id: organizationId,
      project_id: null,
      created_by: userId,
      name: `Dashboard ${n}`,
      description: null,
      is_default: false,
      is_personal: isPersonal,
      schema_version: 1,
      panels: JSON.stringify([]) as unknown as never,
    })
    .returningAll()
    .execute();
  return dashboard;
}

describe('dashboards.max_custom enforcement', () => {
  let app: FastifyInstance;
  let orgId: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(contextPlugin);
    await app.register(customDashboardsRoutes, { prefix: '/api/v1/dashboards' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    await db.deleteFrom('custom_dashboards').execute();
    await db.deleteFrom('sessions').execute();
    await db.deleteFrom('organization_members').execute();
    await db.deleteFrom('projects').execute();
    await db.deleteFrom('organizations').execute();
    await db.deleteFrom('users').execute();

    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    userId = ctx.user.id;
    token = await createTestSession(userId);
    capabilities.invalidate(orgId);
  });

  // Case 1: at limit => blocked (personal dashboard counts too)
  it('blocks dashboard creation when at the limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'dashboards.max_custom', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);

    // Insert one personal dashboard - it should count toward the limit
    await insertDashboard(orgId, userId, 1, true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dashboards',
      headers: { Authorization: `Bearer ${token}` },
      payload: { organizationId: orgId, name: 'New Dashboard' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.statusCode).toBe(403);
    expect(body.code).toBe('capability.dashboards.max_custom.limit_reached');
  });

  // Case 2: under limit => passes
  it('allows dashboard creation when under the limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'dashboards.max_custom', enabled: null, limit_value: 2 })
      .execute();
    capabilities.invalidate(orgId);

    await insertDashboard(orgId, userId, 1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dashboards',
      headers: { Authorization: `Bearer ${token}` },
      payload: { organizationId: orgId, name: 'New Dashboard' },
    });

    expect(res.statusCode).toBe(201);
  });

  // Case 3: unlimited default (no entitlement row) => passes
  it('allows dashboard creation when no limit is configured (unlimited default)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dashboards',
      headers: { Authorization: `Bearer ${token}` },
      payload: { organizationId: orgId, name: 'New Dashboard' },
    });

    expect(res.statusCode).toBe(201);
  });

  // Case 4: org isolation => org A at limit does not block org B
  it('does not block org B when org A is at the limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'dashboards.max_custom', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);
    await insertDashboard(orgId, userId, 1);

    const ctxB = await createTestContext();
    const tokenB = await createTestSession(ctxB.user.id);
    capabilities.invalidate(ctxB.organization.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dashboards',
      headers: { Authorization: `Bearer ${tokenB}` },
      payload: { organizationId: ctxB.organization.id, name: 'New Dashboard' },
    });

    expect(res.statusCode).toBe(201);
  });
});
