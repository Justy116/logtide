import { describe, it, expect } from 'vitest';
import { context } from '@logtide/shared/context';
import { wrapProcessorWithContext, attachContextToPayload } from '../../context/bullmq-context.js';

describe('Request context propagation (integration)', () => {
  it('establishes a context for HTTP requests via contextPlugin', async () => {
    const Fastify = (await import('fastify')).default;
    const { contextPlugin } = await import('../../context/fastify-plugin.js');
    const app = Fastify({ logger: false });
    await app.register(contextPlugin);
    let captured: string | null = null;
    app.get('/__test/ctx', async () => {
      captured = context.current().requestId;
      return { ok: true };
    });
    const res = await app.inject({ method: 'GET', url: '/__test/ctx' });
    expect(res.statusCode).toBe(200);
    expect(captured).toBeTruthy();
    await app.close();
  });

  it('propagates the same requestId from producer to consumer', async () => {
    const seen: { producer?: string; consumer?: string } = {};

    const wrapped = wrapProcessorWithContext('test', async (_job) => {
      seen.consumer = context.current().requestId;
    });

    await context.run(
      {
        requestId: 'req-corr',
        origin: 'http',
        actor: { type: 'system', id: null },
        organizationId: null,
        projectId: null,
      },
      async () => {
        seen.producer = context.current().requestId;
        const payload = attachContextToPayload({ foo: 1 });
        await wrapped({ id: 'j', name: 'test', data: payload as any });
      }
    );

    expect(seen.producer).toBe('req-corr');
    expect(seen.consumer).toBe('req-corr');
  });
});
