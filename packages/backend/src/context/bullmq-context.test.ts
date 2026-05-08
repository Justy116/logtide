import { describe, it, expect, vi } from 'vitest';
import { context, withContext } from '@logtide/shared/context';
import { attachContextToPayload, wrapProcessorWithContext, CTX_KEY } from './bullmq-context.js';

describe('attachContextToPayload', () => {
  it('returns input unchanged when no context', () => {
    const data = { foo: 1 };
    expect(attachContextToPayload(data)).toBe(data);
  });

  it('adds _ctx with v=1 when a context is active', async () => {
    await withContext({ requestId: 'req-1', organizationId: 'org-1' }, async () => {
      const out = attachContextToPayload({ foo: 1 }) as any;
      expect(out._ctx.v).toBe(1);
      expect(out._ctx.requestId).toBe('req-1');
      expect(out._ctx.organizationId).toBe('org-1');
      expect(out.foo).toBe(1);
    });
  });

  it('handles non-object payloads gracefully', () => {
    expect(attachContextToPayload('hello' as unknown as object)).toBe('hello');
  });
});

describe('wrapProcessorWithContext', () => {
  it('strips _ctx and runs processor inside context.run', async () => {
    const processor = vi.fn(async (job) => {
      // expect data does not contain _ctx
      expect((job.data as any)._ctx).toBeUndefined();
      // expect context is established
      const ctx = context.current();
      expect(ctx.requestId).toBe('req-7');
      expect(ctx.origin).toBe('job');
    });

    const wrapped = wrapProcessorWithContext('test-job', processor);
    await wrapped({
      id: 'j1',
      name: 'test-job',
      data: {
        payload: 'x',
        [CTX_KEY]: {
          v: 1,
          requestId: 'req-7',
          origin: 'http',
          actor: { type: 'system', id: null },
          organizationId: null,
          projectId: null,
        },
      } as any,
    });
    expect(processor).toHaveBeenCalledOnce();
  });

  it('falls back to runAsSystem when _ctx is missing', async () => {
    const processor = vi.fn(async () => {
      const ctx = context.current();
      expect(ctx.origin).toBe('system');
      expect(ctx.systemReason).toBe('bullmq-job:no-ctx-job');
    });

    const wrapped = wrapProcessorWithContext('no-ctx-job', processor);
    await wrapped({ id: 'j2', name: 'no-ctx-job', data: { payload: 'y' } as any });
    expect(processor).toHaveBeenCalledOnce();
  });

  it('falls back to runAsSystem when _ctx has unknown version', async () => {
    const processor = vi.fn(async () => {
      const ctx = context.current();
      expect(ctx.origin).toBe('system');
    });

    const wrapped = wrapProcessorWithContext('bad-ctx-job', processor);
    await wrapped({
      id: 'j3',
      name: 'bad-ctx-job',
      data: { [CTX_KEY]: { v: 99 } } as any,
    });
    expect(processor).toHaveBeenCalledOnce();
  });
});
