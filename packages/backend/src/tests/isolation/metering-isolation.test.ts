import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import { build } from '../../server.js';
import { truncateAllTables } from '../helpers/index.js';
import { createTestSession } from '../helpers/auth.js';
import { createIsolatedTenants } from './helpers.js';
import { metricsService } from '../../modules/metrics/index.js';

const FROM = '2000-01-01T00:00:00.000Z';
const TO = '2100-01-01T00:00:00.000Z';

async function sessionHeader(userId: string) {
  const session = await createTestSession(userId);
  return { Authorization: `Bearer ${session.token}` };
}

async function seedMetric(projectId: string, organizationId: string, metricName: string) {
  await metricsService.ingestMetrics(
    [
      {
        time: new Date(),
        metricName,
        metricType: 'gauge',
        value: 42,
        serviceName: 'test-svc',
      },
    ],
    projectId,
    organizationId,
  );
}

describe('Tenant isolation - metrics', () => {
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

  // ---------------------------------------------------------------------------
  // API key auth: key is always pinned to its own project
  // ---------------------------------------------------------------------------
  it('api key for A1 cannot list metric names from B1 project', async () => {
    const t = await createIsolatedTenants();
    const a1Key = t.orgA.projects[0].apiKey.key;
    const b1Id = t.orgB.projects[0].id;

    await seedMetric(b1Id, t.orgB.id, 'b1.cpu');

    const res = await request(app.server)
      .get('/api/v1/metrics/names')
      .query({ projectId: b1Id, from: FROM, to: TO })
      .set('x-api-key', a1Key);

    // Must be rejected or return A1 metrics (not B1 metrics)
    if (res.status === 200) {
      const raw: unknown[] = res.body.metricNames ?? res.body.names ?? res.body ?? [];
      const names = raw.map((n: any) => (typeof n === 'string' ? n : n.name));
      expect(names).not.toContain('b1.cpu');
    } else {
      expect([401, 403]).toContain(res.status);
    }
  });

  it('api key for B1 can list its own metric names', async () => {
    const t = await createIsolatedTenants();
    const b1Id = t.orgB.projects[0].id;
    const b1Key = t.orgB.projects[0].apiKey.key;

    await seedMetric(b1Id, t.orgB.id, 'b1.requests');

    const res = await request(app.server)
      .get('/api/v1/metrics/names')
      .query({ projectId: b1Id, from: FROM, to: TO })
      .set('x-api-key', b1Key)
      .expect(200);

    // The endpoint returns an array of {name, ...} objects or plain strings
    const raw: unknown[] = res.body.metricNames ?? res.body.names ?? res.body ?? [];
    const names = raw.map((n: any) => (typeof n === 'string' ? n : n.name));
    expect(names).toContain('b1.requests');
  });

  it('api key for A1 cannot query metric data from B1 project', async () => {
    const t = await createIsolatedTenants();
    const a1Key = t.orgA.projects[0].apiKey.key;
    const b1Id = t.orgB.projects[0].id;

    await seedMetric(b1Id, t.orgB.id, 'b1.secret.metric');

    const res = await request(app.server)
      .get('/api/v1/metrics/data')
      .query({ projectId: b1Id, metricName: 'b1.secret.metric', from: FROM, to: TO })
      .set('x-api-key', a1Key);

    if (res.status === 200) {
      const points: any[] = res.body.metrics ?? res.body.data ?? [];
      // None of the returned points should belong to b1
      for (const p of points) {
        expect(p.project_id ?? p.projectId).not.toBe(b1Id);
      }
    } else {
      expect([401, 403]).toContain(res.status);
    }
  });

  // ---------------------------------------------------------------------------
  // Session auth: verifyProjectAccess enforced
  // ---------------------------------------------------------------------------
  it('session user of org B cannot query metrics data for org A project', async () => {
    const t = await createIsolatedTenants();
    const a1Id = t.orgA.projects[0].id;
    const headersB = await sessionHeader(t.orgB.ownerUserId);

    await seedMetric(a1Id, t.orgA.id, 'a1.secret');

    const res = await request(app.server)
      .get('/api/v1/metrics/data')
      .query({ projectId: a1Id, metricName: 'a1.secret', from: FROM, to: TO })
      .set(headersB);

    expect([403, 404]).toContain(res.status);
  });

  it('session user of org A can list metric names for own project', async () => {
    const t = await createIsolatedTenants();
    const a1Id = t.orgA.projects[0].id;
    const headersA = await sessionHeader(t.orgA.ownerUserId);

    await seedMetric(a1Id, t.orgA.id, 'a1.latency');

    const res = await request(app.server)
      .get('/api/v1/metrics/names')
      .query({ projectId: a1Id, from: FROM, to: TO })
      .set(headersA)
      .expect(200);

    const raw: unknown[] = res.body.metricNames ?? res.body.names ?? res.body ?? [];
    const names = raw.map((n: any) => (typeof n === 'string' ? n : n.name));
    expect(names).toContain('a1.latency');
  });

  it('aggregate endpoint rejects api key querying a different project', async () => {
    const t = await createIsolatedTenants();
    const a1Key = t.orgA.projects[0].apiKey.key;
    const b1Id = t.orgB.projects[0].id;

    await seedMetric(b1Id, t.orgB.id, 'b1.mem');

    const res = await request(app.server)
      .get('/api/v1/metrics/aggregate')
      .query({
        projectId: b1Id,
        metricName: 'b1.mem',
        from: FROM,
        to: TO,
        interval: '1h',
        aggregation: 'avg',
      })
      .set('x-api-key', a1Key);

    if (res.status === 200) {
      const buckets: any[] = res.body.buckets ?? res.body.series ?? [];
      // No data should be returned from b1
      expect(buckets).toHaveLength(0);
    } else {
      expect([401, 403]).toContain(res.status);
    }
  });
});
