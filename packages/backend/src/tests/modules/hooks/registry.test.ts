import { describe, it, expect } from 'vitest';
import { HookRegistry } from '../../../hooks/registry.js';
import { HookRejectionError, HookExecutionError } from '../../../hooks/errors.js';
import type { BeforeIngestContext } from '../../../hooks/types.js';

function ingestCtx(overrides: Partial<BeforeIngestContext> = {}): BeforeIngestContext {
  return {
    organizationId: 'org-1',
    projectId: 'proj-1',
    eventCount: 1,
    byteSize: 100,
    records: [
      { time: new Date(), projectId: 'proj-1', service: 'api', level: 'info', message: 'hello' },
    ],
    ...overrides,
  };
}

describe('HookRegistry', () => {
  it('run() is a no-op when no handlers are registered', async () => {
    const registry = new HookRegistry();
    await expect(registry.run('beforeIngest', ingestCtx())).resolves.toBeUndefined();
  });

  it('hasHandlers() reflects registration state', () => {
    const registry = new HookRegistry();
    expect(registry.hasHandlers('beforeIngest')).toBe(false);
    registry.register('beforeIngest', async () => {});
    expect(registry.hasHandlers('beforeIngest')).toBe(true);
    expect(registry.hasHandlers('beforeQuery')).toBe(false);
  });

  it('executes handlers sequentially in registration order', async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    registry.register('beforeIngest', async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('first-end');
    });
    registry.register('beforeIngest', async () => {
      order.push('second');
    });
    await registry.run('beforeIngest', ingestCtx());
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('later handlers see mutations from earlier ones', async () => {
    const registry = new HookRegistry();
    let secondSawCount = -1;
    registry.register('beforeIngest', async (ctx) => {
      ctx.records = [];
    });
    registry.register('beforeIngest', async (ctx) => {
      secondSawCount = ctx.records.length;
    });
    const ctx = ingestCtx();
    await registry.run('beforeIngest', ctx);
    expect(secondSawCount).toBe(0);
    expect(ctx.records).toHaveLength(0);
  });

  it('HookRejectionError short-circuits and propagates as-is', async () => {
    const registry = new HookRegistry();
    let secondRan = false;
    registry.register('beforeIngest', async () => {
      throw new HookRejectionError('quota.exceeded', 'Monthly limit reached', 429);
    });
    registry.register('beforeIngest', async () => {
      secondRan = true;
    });
    try {
      await registry.run('beforeIngest', ingestCtx());
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HookRejectionError);
      expect((e as HookRejectionError).code).toBe('quota.exceeded');
      expect((e as HookRejectionError).statusCode).toBe(429);
      expect((e as HookRejectionError).message).toBe('Monthly limit reached');
    }
    expect(secondRan).toBe(false);
  });

  it('HookRejectionError defaults statusCode to 403', () => {
    const err = new HookRejectionError('policy.denied', 'nope');
    expect(err.statusCode).toBe(403);
  });

  it('unexpected errors are wrapped in HookExecutionError (500, fail-closed)', async () => {
    const registry = new HookRegistry();
    registry.register('beforeIngest', async () => {
      throw new TypeError('boom');
    });
    try {
      await registry.run('beforeIngest', ingestCtx());
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HookExecutionError);
      expect((e as HookExecutionError).statusCode).toBe(500);
      expect((e as HookExecutionError).code).toBe('hook.execution_failed');
      // original message must NOT leak into the client-facing message
      expect((e as HookExecutionError).message).not.toContain('boom');
    }
  });

  it('clear() removes all handlers in all phases', async () => {
    const registry = new HookRegistry();
    registry.register('beforeIngest', async () => {});
    registry.register('beforeQuery', async () => {});
    registry.clear();
    expect(registry.hasHandlers('beforeIngest')).toBe(false);
    expect(registry.hasHandlers('beforeQuery')).toBe(false);
  });

  it('phases are isolated from each other', async () => {
    const registry = new HookRegistry();
    let ingestRan = false;
    registry.register('beforeIngest', async () => {
      ingestRan = true;
    });
    await registry.run('beforeQuery', {
      organizationId: 'org-1',
      projectIds: ['proj-1'],
      params: { projectId: 'proj-1' },
    });
    expect(ingestRan).toBe(false);
  });
});
