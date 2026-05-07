import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { context } from '@logtide/shared';
import { contextPlugin } from './fastify-plugin.js';

describe('contextPlugin', () => {
  async function buildApp() {
    const app = Fastify({ logger: false });
    await app.register(contextPlugin);
    app.get('/echo', async (req) => {
      // Mimic auth plugin populating fields
      const r = req as any;
      r.organizationId = r.headers['x-org'] as string | undefined;
      r.apiKeyId = r.headers['x-key'] as string | undefined;
      r.user = r.headers['x-user']
        ? { id: r.headers['x-user'] as string, email: 'u@test' }
        : undefined;
      // The plugin already established context in onRequest based on request.id only.
      // For the test we re-establish by reading current() to make sure it doesn't throw.
      const ctx = context.current();
      return { requestId: ctx.requestId, origin: ctx.origin, actorType: ctx.actor.type };
    });
    return app;
  }

  it('establishes a context for every request (anonymous)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/echo' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.origin).toBe('http');
    expect(body.actorType).toBe('system'); // no auth fields populated
    expect(body.requestId).toBeTruthy();
    await app.close();
  });
});
