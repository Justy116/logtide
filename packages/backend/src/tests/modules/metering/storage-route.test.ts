import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db } from '../../../database/index.js';
import { usageRoutes } from '../../../modules/metering/index.js';
import { createTestContext } from '../../helpers/factories.js';

async function createTestSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  await db
    .insertInto('sessions')
    .values({ user_id: userId, token, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) })
    .execute();
  return token;
}

async function insertSnapshot(orgId: string, projectId: string, quantity: number, time: Date) {
  await db
    .insertInto('metering_events')
    .values({ time, organization_id: orgId, project_id: projectId, type: 'storage.snapshot', quantity, metadata: null })
    .execute();
}

describe('GET /api/v1/usage/storage', () => {
  let app: FastifyInstance;
  let orgId: string;
  let projectId: string;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(usageRoutes, { prefix: '/api/v1/usage' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('metering_events').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;
    token = await createTestSession(ctx.user.id);
  });

  function url(from: string, to: string) {
    return `/api/v1/usage/storage?organizationId=${orgId}&from=${from}&to=${to}`;
  }

  it('returns the current estimate and the daily series', async () => {
    await insertSnapshot(orgId, projectId, 100, new Date('2026-06-01T12:00:00Z'));
    await insertSnapshot(orgId, projectId, 250, new Date('2026-06-02T12:00:00Z'));

    const res = await app.inject({
      method: 'GET',
      url: url('2026-06-01T00:00:00Z', '2026-06-03T00:00:00Z'),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.current).toBe(250);
    expect(body.series).toEqual([
      { bucket: '2026-06-01', quantity: 100 },
      { bucket: '2026-06-02', quantity: 250 },
    ]);
  });

  it('rejects a non-member with 403', async () => {
    const other = await createTestContext();
    const otherToken = await createTestSession(other.user.id);

    const res = await app.inject({
      method: 'GET',
      url: url('2026-06-01T00:00:00Z', '2026-06-03T00:00:00Z'),
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 on a missing organizationId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/usage/storage?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('usage breakdown excludes storage.snapshot from byType', () => {
  let app: FastifyInstance;
  let orgId: string;
  let projectId: string;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(usageRoutes, { prefix: '/api/v1/usage' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('metering_events').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;
    token = await createTestSession(ctx.user.id);
  });

  it('byType lists counters but never the storage.snapshot gauge', async () => {
    const now = new Date();
    await db
      .insertInto('metering_events')
      .values([
        { time: now, organization_id: orgId, project_id: projectId, type: 'logs.ingested.events', quantity: 10, metadata: null },
        { time: now, organization_id: orgId, project_id: projectId, type: 'storage.snapshot', quantity: 5000, metadata: null },
      ])
      .execute();

    const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/usage/breakdown?organizationId=${orgId}&from=${from}&to=${to}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const types = body.breakdown.byType.map((t: { type: string }) => t.type);
    expect(types).toContain('logs.ingested.events');
    expect(types).not.toContain('storage.snapshot');
  });
});
