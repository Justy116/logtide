import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db } from '../../../database/index.js';
import { notificationChannelsRoutes } from '../../../modules/notification-channels/routes.js';
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

async function insertChannel(organizationId: string, n = 1) {
  const [channel] = await db
    .insertInto('notification_channels')
    .values({
      organization_id: organizationId,
      name: `Channel ${n}`,
      type: 'email',
      config: { recipients: [`test${n}@example.com`] },
    })
    .returningAll()
    .execute();
  return channel;
}

function createChannelPayload(n = 99) {
  return {
    name: `New Channel ${n}`,
    type: 'email',
    config: { recipients: [`new${n}@example.com`] },
  };
}

describe('notifications.max_channels enforcement', () => {
  let app: FastifyInstance;
  let orgId: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(contextPlugin);
    await app.register(notificationChannelsRoutes, { prefix: '/api/v1/notification-channels' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    await db.deleteFrom('organization_default_channels').execute();
    await db.deleteFrom('alert_rule_channels').execute();
    await db.deleteFrom('sigma_rule_channels').execute();
    await db.deleteFrom('incident_channels').execute();
    await db.deleteFrom('error_group_channels').execute();
    await db.deleteFrom('notification_channels').execute();
    await db.deleteFrom('alert_rules').execute();
    await db.deleteFrom('sigma_rules').execute();
    await db.deleteFrom('api_keys').execute();
    await db.deleteFrom('notifications').execute();
    await db.deleteFrom('organization_members').execute();
    await db.deleteFrom('projects').execute();
    await db.deleteFrom('organizations').execute();
    await db.deleteFrom('sessions').execute();
    await db.deleteFrom('users').execute();

    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    userId = ctx.user.id;
    token = await createTestSession(userId);
    capabilities.invalidate(orgId);
  });

  // Case 1: at limit => blocked
  it('blocks channel creation when at the limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'notifications.max_channels', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);

    await insertChannel(orgId, 1);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/notification-channels?organizationId=${orgId}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: createChannelPayload(2),
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.statusCode).toBe(403);
    expect(body.code).toBe('capability.notifications.max_channels.limit_reached');
  });

  // Case 2: under limit => passes
  it('allows channel creation when under the limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'notifications.max_channels', enabled: null, limit_value: 2 })
      .execute();
    capabilities.invalidate(orgId);

    await insertChannel(orgId, 1);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/notification-channels?organizationId=${orgId}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: createChannelPayload(2),
    });

    expect(res.statusCode).toBe(201);
  });

  // Case 3: unlimited default (no entitlement row) => passes
  it('allows channel creation when no limit is configured (unlimited default)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/notification-channels?organizationId=${orgId}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: createChannelPayload(1),
    });

    expect(res.statusCode).toBe(201);
  });

  // Case 4: org isolation => org A at limit does not block org B
  it('does not block org B when org A is at the limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'notifications.max_channels', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);
    await insertChannel(orgId, 1);

    const ctxB = await createTestContext();
    const tokenB = await createTestSession(ctxB.user.id);
    capabilities.invalidate(ctxB.organization.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/notification-channels?organizationId=${ctxB.organization.id}`,
      headers: { Authorization: `Bearer ${tokenB}` },
      payload: createChannelPayload(1),
    });

    expect(res.statusCode).toBe(201);
  });
});
