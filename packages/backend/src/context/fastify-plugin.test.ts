import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { context } from '@logtide/shared/context';
import { contextPlugin } from './fastify-plugin.js';

describe('contextPlugin', () => {
  async function buildApp(authStub?: (req: any) => void) {
    const app = Fastify({ logger: false });
    if (authStub) {
      // Simulate the auth plugin running BEFORE contextPlugin (registration order)
      app.addHook('onRequest', async (req) => {
        authStub(req);
      });
    }
    await app.register(contextPlugin);
    app.get('/echo', async () => {
      const ctx = context.current();
      return {
        requestId: ctx.requestId,
        origin: ctx.origin,
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        organizationId: ctx.organizationId,
      };
    });
    return app;
  }

  it('establishes a context for every request (anonymous)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/echo' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.origin).toBe('http');
    expect(body.actorType).toBe('system');
    expect(body.requestId).toBeTruthy();
    await app.close();
  });

  it('captures user actor when auth populated request.user', async () => {
    const app = await buildApp((req) => {
      req.user = { id: 'u-abc', email: 'alice@test' };
      req.organizationId = 'org-1';
    });
    const res = await app.inject({ method: 'GET', url: '/echo' });
    const body = res.json();
    expect(body.actorType).toBe('user');
    expect(body.actorId).toBe('u-abc');
    expect(body.organizationId).toBe('org-1');
    await app.close();
  });

  it('captures apiKey actor when auth populated request.apiKeyId', async () => {
    const app = await buildApp((req) => {
      req.apiKeyId = 'key-xyz';
      req.apiKeyType = 'write';
      req.organizationId = 'org-2';
      req.projectId = 'proj-2';
    });
    const res = await app.inject({ method: 'GET', url: '/echo' });
    const body = res.json();
    expect(body.actorType).toBe('apiKey');
    expect(body.actorId).toBe('key-xyz');
    expect(body.organizationId).toBe('org-2');
    await app.close();
  });
});
