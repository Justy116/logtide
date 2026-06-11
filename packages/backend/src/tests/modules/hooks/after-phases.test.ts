import { describe, it, expect, vi, afterEach } from 'vitest';
import { HookRegistry } from '../../../hooks/registry.js';
import type {
  AfterIngestContext,
  AfterAlertTriggeredContext,
  AfterWebhookDispatchContext,
} from '../../../hooks/types.js';

function afterIngestCtx(overrides: Partial<AfterIngestContext> = {}): AfterIngestContext {
  return {
    organizationId: 'org-1',
    projectId: 'proj-1',
    acceptedCount: 5,
    rejectedCount: 1,
    rejectionReasons: ['pii_masking_failed'],
    ...overrides,
  };
}

function afterAlertCtx(overrides: Partial<AfterAlertTriggeredContext> = {}): AfterAlertTriggeredContext {
  return {
    organizationId: 'org-1',
    projectId: 'proj-1',
    ruleId: 'rule-abc',
    ruleName: 'High error rate',
    historyId: 'hist-xyz',
    logCount: 42,
    baselineMetadata: null,
    ...overrides,
  };
}

function afterWebhookCtx(overrides: Partial<AfterWebhookDispatchContext> = {}): AfterWebhookDispatchContext {
  return {
    organizationId: 'org-1',
    eventType: 'alert.triggered',
    url: 'https://example.com/hook',
    success: true,
    statusCode: 200,
    durationMs: 55,
    error: null,
    retryable: false,
    ...overrides,
  };
}

describe('runAfter - afterIngest', () => {
  it('hasHandlers returns false by default', () => {
    const registry = new HookRegistry();
    expect(registry.hasHandlers('afterIngest')).toBe(false);
  });

  it('hasHandlers returns true after registering a handler', () => {
    const registry = new HookRegistry();
    registry.register('afterIngest', async () => {});
    expect(registry.hasHandlers('afterIngest')).toBe(true);
  });

  it('invokes handlers in registration order', async () => {
    const registry = new HookRegistry();
    const order: number[] = [];
    registry.register('afterIngest', async () => { order.push(1); });
    registry.register('afterIngest', async () => { order.push(2); });
    await registry.runAfter('afterIngest', afterIngestCtx());
    expect(order).toEqual([1, 2]);
  });

  it('passes the context to handlers', async () => {
    const registry = new HookRegistry();
    let received: AfterIngestContext | null = null;
    registry.register('afterIngest', async (ctx) => { received = ctx; });
    const ctx = afterIngestCtx();
    await registry.runAfter('afterIngest', ctx);
    expect(received).not.toBeNull();
    expect((received as unknown as AfterIngestContext).acceptedCount).toBe(5);
    expect((received as unknown as AfterIngestContext).rejectionReasons).toEqual(['pii_masking_failed']);
  });

  it('context is frozen', async () => {
    const registry = new HookRegistry();
    let received: AfterIngestContext | null = null;
    registry.register('afterIngest', async (ctx) => { received = ctx; });
    await registry.runAfter('afterIngest', afterIngestCtx());
    expect(Object.isFrozen(received)).toBe(true);
  });

  it('a throwing handler does not reject runAfter', async () => {
    const registry = new HookRegistry();
    registry.register('afterIngest', async () => { throw new Error('boom'); });
    await expect(registry.runAfter('afterIngest', afterIngestCtx())).resolves.toBeUndefined();
  });

  it('logs a warning when a handler throws', async () => {
    const registry = new HookRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registry.register('afterIngest', async () => { throw new Error('oops'); });
    await registry.runAfter('afterIngest', afterIngestCtx());
    expect(warn).toHaveBeenCalledOnce();
    const [msg] = warn.mock.calls[0] as [string, ...unknown[]];
    expect(msg).toContain('[Hooks]');
    expect(msg).toContain('afterIngest');
    warn.mockRestore();
  });

  it('subsequent handlers still run after a throw', async () => {
    const registry = new HookRegistry();
    let secondRan = false;
    registry.register('afterIngest', async () => { throw new Error('first fails'); });
    registry.register('afterIngest', async () => { secondRan = true; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await registry.runAfter('afterIngest', afterIngestCtx());
    expect(secondRan).toBe(true);
    warn.mockRestore();
  });

  it('runAfter is a no-op when no handlers registered', async () => {
    const registry = new HookRegistry();
    await expect(registry.runAfter('afterIngest', afterIngestCtx())).resolves.toBeUndefined();
  });
});

describe('runAfter - afterAlertTriggered', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hasHandlers false by default', () => {
    const registry = new HookRegistry();
    expect(registry.hasHandlers('afterAlertTriggered')).toBe(false);
  });

  it('invokes handlers in order', async () => {
    const registry = new HookRegistry();
    const order: number[] = [];
    registry.register('afterAlertTriggered', async () => { order.push(1); });
    registry.register('afterAlertTriggered', async () => { order.push(2); });
    await registry.runAfter('afterAlertTriggered', afterAlertCtx());
    expect(order).toEqual([1, 2]);
  });

  it('context is frozen', async () => {
    const registry = new HookRegistry();
    let received: AfterAlertTriggeredContext | null = null;
    registry.register('afterAlertTriggered', async (ctx) => { received = ctx; });
    await registry.runAfter('afterAlertTriggered', afterAlertCtx());
    expect(Object.isFrozen(received)).toBe(true);
  });

  it('throwing handler does not reject and subsequent handlers run', async () => {
    const registry = new HookRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let secondRan = false;
    registry.register('afterAlertTriggered', async () => { throw new TypeError('fail'); });
    registry.register('afterAlertTriggered', async () => { secondRan = true; });
    await expect(registry.runAfter('afterAlertTriggered', afterAlertCtx())).resolves.toBeUndefined();
    expect(secondRan).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    const [msg] = warn.mock.calls[0] as [string, ...unknown[]];
    expect(msg).toContain('afterAlertTriggered');
  });
});

describe('runAfter - afterWebhookDispatch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hasHandlers false by default', () => {
    const registry = new HookRegistry();
    expect(registry.hasHandlers('afterWebhookDispatch')).toBe(false);
  });

  it('invokes handlers in order', async () => {
    const registry = new HookRegistry();
    const order: number[] = [];
    registry.register('afterWebhookDispatch', async () => { order.push(1); });
    registry.register('afterWebhookDispatch', async () => { order.push(2); });
    await registry.runAfter('afterWebhookDispatch', afterWebhookCtx());
    expect(order).toEqual([1, 2]);
  });

  it('context is frozen', async () => {
    const registry = new HookRegistry();
    let received: AfterWebhookDispatchContext | null = null;
    registry.register('afterWebhookDispatch', async (ctx) => { received = ctx; });
    await registry.runAfter('afterWebhookDispatch', afterWebhookCtx());
    expect(Object.isFrozen(received)).toBe(true);
  });

  it('throwing handler does not reject and subsequent handlers run', async () => {
    const registry = new HookRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let secondRan = false;
    registry.register('afterWebhookDispatch', async () => { throw new Error('dispatch fail'); });
    registry.register('afterWebhookDispatch', async () => { secondRan = true; });
    await expect(registry.runAfter('afterWebhookDispatch', afterWebhookCtx())).resolves.toBeUndefined();
    expect(secondRan).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('passes correct context fields to handler', async () => {
    const registry = new HookRegistry();
    let received: AfterWebhookDispatchContext | null = null;
    registry.register('afterWebhookDispatch', async (ctx) => { received = ctx; });
    const ctx = afterWebhookCtx({ success: false, statusCode: 503, error: 'Service Unavailable', retryable: true });
    await registry.runAfter('afterWebhookDispatch', ctx);
    expect((received as unknown as AfterWebhookDispatchContext).success).toBe(false);
    expect((received as unknown as AfterWebhookDispatchContext).statusCode).toBe(503);
    expect((received as unknown as AfterWebhookDispatchContext).retryable).toBe(true);
  });
});
