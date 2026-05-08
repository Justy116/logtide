import { run } from './storage.js';
import type { RequestContext } from './types.js';

/**
 * Test helper: runs `fn` inside a synthetic context.
 * Sensible defaults; merge in `partial` to override.
 */
export async function withContext<T>(
  partial: Partial<RequestContext>,
  fn: () => Promise<T> | T
): Promise<T> {
  const ctx: RequestContext = {
    requestId: 'test-req-id',
    origin: 'http',
    actor: { type: 'system', id: null },
    organizationId: null,
    projectId: null,
    ...partial,
  };
  return run(ctx, fn);
}
