import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import { build } from '../../server.js';
import { truncateAllTables, createTestLog } from '../helpers/index.js';
import { createIsolatedTenants } from './helpers.js';

describe('Tenant isolation - query API', () => {
  let app: FastifyInstance;

  const FROM = '2000-01-01T00:00:00.000Z';
  const TO = '2100-01-01T00:00:00.000Z';

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

  it('org B api key returns only its own logs', async () => {
    const t = await createIsolatedTenants();
    const a1Id = t.orgA.projects[0].id;
    const a2Id = t.orgA.projects[1].id;
    const b1Id = t.orgB.projects[0].id;
    const b1Key = t.orgB.projects[0].apiKey.key;

    await createTestLog({ projectId: a1Id, message: 'A1-secret', time: new Date() });
    await createTestLog({ projectId: a2Id, message: 'A2-secret', time: new Date() });
    await createTestLog({ projectId: b1Id, message: 'B1-secret', time: new Date() });

    const res = await request(app.server)
      .get('/api/v1/logs')
      .query({ projectId: b1Id, from: FROM, to: TO })
      .set('x-api-key', b1Key)
      .expect(200);

    const messages: string[] = res.body.logs.map((l: any) => l.message);
    expect(messages).toContain('B1-secret');
    expect(messages).not.toContain('A1-secret');
    expect(messages).not.toContain('A2-secret');
  });

  it('api key for project A1 cannot read project A2 logs (same org)', async () => {
    const t = await createIsolatedTenants();
    const a1Id = t.orgA.projects[0].id;
    const a2Id = t.orgA.projects[1].id;
    const b1Id = t.orgB.projects[0].id;
    const a1Key = t.orgA.projects[0].apiKey.key;

    await createTestLog({ projectId: a1Id, message: 'A1-secret', time: new Date() });
    await createTestLog({ projectId: a2Id, message: 'A2-secret', time: new Date() });
    await createTestLog({ projectId: b1Id, message: 'B1-secret', time: new Date() });

    const res = await request(app.server)
      .get('/api/v1/logs')
      .query({ projectId: a2Id, from: FROM, to: TO })
      .set('x-api-key', a1Key);

    // Acceptable outcomes: 401/403 (explicit rejection) or 200 with empty/A1-only results.
    // A2-secret must NEVER appear regardless of status code.
    if (res.status === 200) {
      const messages: string[] = res.body.logs.map((l: any) => l.message);
      expect(messages).not.toContain('A2-secret');
    } else {
      expect([401, 403]).toContain(res.status);
    }
  });

  it('api key for org B cannot read org A project logs', async () => {
    const t = await createIsolatedTenants();
    const a1Id = t.orgA.projects[0].id;
    const a2Id = t.orgA.projects[1].id;
    const b1Id = t.orgB.projects[0].id;
    const b1Key = t.orgB.projects[0].apiKey.key;

    await createTestLog({ projectId: a1Id, message: 'A1-secret', time: new Date() });
    await createTestLog({ projectId: a2Id, message: 'A2-secret', time: new Date() });
    await createTestLog({ projectId: b1Id, message: 'B1-secret', time: new Date() });

    const res = await request(app.server)
      .get('/api/v1/logs')
      .query({ projectId: a1Id, from: FROM, to: TO })
      .set('x-api-key', b1Key);

    // Acceptable outcomes: 401/403 (explicit rejection) or 200 with no A1-secret.
    if (res.status === 200) {
      const messages: string[] = res.body.logs.map((l: any) => l.message);
      expect(messages).not.toContain('A1-secret');
    } else {
      expect([401, 403]).toContain(res.status);
    }
  });
});
