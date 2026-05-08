import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from './types.js';

export const contextStorage = new AsyncLocalStorage<RequestContext>();

export async function run<T>(ctx: RequestContext, fn: () => Promise<T> | T): Promise<T> {
  return contextStorage.run(ctx, fn);
}

export function enterWith(ctx: RequestContext): void {
  contextStorage.enterWith(ctx);
}

export function currentOrNull(): RequestContext | undefined {
  return contextStorage.getStore();
}

export function current(): RequestContext {
  const ctx = contextStorage.getStore();
  if (!ctx) {
    throw new Error('RequestContext not established (call context.run / context.enterWith first)');
  }
  return ctx;
}

export async function withPatch<T>(
  patch: Partial<RequestContext>,
  fn: () => Promise<T> | T
): Promise<T> {
  const base = current();
  const next: RequestContext = { ...base, ...patch };
  return contextStorage.run(next, fn);
}

export async function runAsSystem<T>(reason: string, fn: () => Promise<T> | T): Promise<T> {
  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('runAsSystem requires a non-empty reason');
  }
  const ctx: RequestContext = {
    requestId: randomUUID(),
    origin: 'system',
    actor: { type: 'system', id: null },
    organizationId: null,
    projectId: null,
    systemReason: reason.trim(),
  };
  return contextStorage.run(ctx, fn);
}
