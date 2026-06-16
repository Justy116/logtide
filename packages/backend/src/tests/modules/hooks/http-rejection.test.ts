import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { reservoirReady } from '../../../database/reservoir.js';
import { db } from '../../../database/index.js';
import { hooks, HookRejectionError } from '../../../hooks/index.js';
import { createTestContext } from '../../helpers/factories.js';
import { build } from '../../../server.js';
import otlpRoutes from '../../../modules/otlp/routes.js';

async function createTestSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  await db
    .insertInto('sessions')
    .values({ user_id: userId, token, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) })
    .execute();
  return token;
}

describe('hook rejections through the OTLP HTTP stack', () => {
  let app: any;
  let projectId: string;

  beforeAll(async () => {
    await reservoirReady;
  });

  beforeEach(async () => {
    hooks.clear();
    const ctx = await createTestContext();
    projectId = ctx.project.id;

    app = Fastify();
    app.addHook('onRequest', async (request: any) => {
      request.projectId = projectId;
    });
    await app.register(otlpRoutes);
    await app.ready();
  });

  afterEach(async () => {
    hooks.clear();
    await app.close();
  });

  function otlpLogsBody() {
    const now = String(Date.now() * 1_000_000);
    return {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
          scopeLogs: [
            { logRecords: [{ timeUnixNano: now, severityNumber: 9, body: { stringValue: 'hello' } }] },
          ],
        },
      ],
    };
  }

  it('HookRejectionError keeps its status code through the OTLP route', async () => {
    hooks.register('beforeIngest', async () => {
      throw new HookRejectionError('policy.denied', 'not allowed', 403);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/otlp/logs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(otlpLogsBody()),
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload);
    expect(body.partialSuccess.rejectedLogRecords).toBe(-1);
    expect(body.partialSuccess.errorMessage).toBe('not allowed');
  });

  it('a broken hook returns a retryable 503, not a permanent 400', async () => {
    hooks.register('beforeIngest', async () => {
      throw new TypeError('broken hook');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/otlp/logs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(otlpLogsBody()),
    });

    expect(res.statusCode).toBe(503);
  });
});

describe('global error handler surfaces hook rejection statusCode and code', () => {
  let fullApp: FastifyInstance;
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    await reservoirReady;
    fullApp = await build();
    await fullApp.ready();
  });

  afterAll(async () => {
    hooks.clear();
    await fullApp.close();
  });

  beforeEach(async () => {
    hooks.clear();
    const ctx = await createTestContext();
    projectId = ctx.project.id;
    token = await createTestSession(ctx.user.id);
  });

  afterEach(() => {
    hooks.clear();
  });

  it('beforeQuery rejection returns the hook status code and code through the global handler', async () => {
    hooks.register('beforeQuery', async () => {
      throw new HookRejectionError('policy.query_blocked', 'query not allowed', 403);
    });

    const res = await fullApp.inject({
      method: 'GET',
      url: `/api/v1/logs?projectId=${projectId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload);
    expect(body.code).toBe('policy.query_blocked');
  });
});
