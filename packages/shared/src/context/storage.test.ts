import { describe, it, expect } from 'vitest';
import {
  contextStorage,
  run,
  enterWith,
  current,
  currentOrNull,
  withPatch,
  runAsSystem,
} from './storage.js';
import type { RequestContext } from './types.js';

const baseCtx: RequestContext = {
  requestId: 'req-1',
  origin: 'http',
  actor: { type: 'user', id: 'u1', email: 'a@b.test' },
  organizationId: 'org-1',
  projectId: 'p-1',
};

describe('context.current', () => {
  it('throws when no context is established', () => {
    expect(() => current()).toThrow(/RequestContext not established/);
  });

  it('returns the current context inside run', async () => {
    await run(baseCtx, async () => {
      expect(current()).toEqual(baseCtx);
    });
  });

  it('isolates concurrent runs', async () => {
    const a = { ...baseCtx, requestId: 'A' };
    const b = { ...baseCtx, requestId: 'B' };
    await Promise.all([
      run(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        expect(current().requestId).toBe('A');
      }),
      run(b, async () => {
        await new Promise((r) => setTimeout(r, 1));
        expect(current().requestId).toBe('B');
      }),
    ]);
  });
});

describe('context.currentOrNull', () => {
  it('returns undefined when no context', () => {
    expect(currentOrNull()).toBeUndefined();
  });

  it('returns context inside run', async () => {
    await run(baseCtx, async () => {
      expect(currentOrNull()).toEqual(baseCtx);
    });
  });
});

describe('context.enterWith', () => {
  it('persists for the rest of the async chain', async () => {
    await contextStorage.run(undefined as unknown as RequestContext, async () => {
      // simulate Fastify hook: enterWith inside an outer scope
      enterWith(baseCtx);
      await new Promise((r) => setTimeout(r, 1));
      expect(current()).toEqual(baseCtx);
    });
  });
});

describe('context.with', () => {
  it('preserves requestId by default', async () => {
    await run(baseCtx, async () => {
      await withPatch({ projectId: 'p-2' }, async () => {
        expect(current().projectId).toBe('p-2');
        expect(current().requestId).toBe('req-1');
      });
    });
  });

  it('throws if called outside a context', async () => {
    await expect(withPatch({}, async () => {})).rejects.toThrow(/RequestContext not established/);
  });
});

describe('context.runAsSystem', () => {
  it('requires a non-empty reason', async () => {
    await expect(runAsSystem('', async () => {})).rejects.toThrow(/non-empty reason/);
  });

  it('establishes a system context with generated requestId', async () => {
    let captured: RequestContext | null = null;
    await runAsSystem('test-cron', async () => {
      captured = current();
    });
    expect(captured).not.toBeNull();
    expect(captured!.origin).toBe('system');
    expect(captured!.actor).toEqual({ type: 'system', id: null });
    expect(captured!.systemReason).toBe('test-cron');
    expect(captured!.organizationId).toBeNull();
    expect(captured!.projectId).toBeNull();
    expect(captured!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
