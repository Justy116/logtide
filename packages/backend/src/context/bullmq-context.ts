import { currentOrNull, deserializeContext, run, runAsSystem, serializeContext } from '@logtide/shared';
import type { JobProcessor } from '../queue/abstractions/types.js';

export const CTX_KEY = '_ctx';

/**
 * Adds `_ctx` to a job payload if a context is currently active.
 * Returns the (possibly modified) payload as `unknown` to keep adapter generics sane.
 */
export function attachContextToPayload<T>(data: T): T {
  const ctx = currentOrNull();
  if (!ctx) return data;
  if (typeof data !== 'object' || data === null) return data;
  return { ...(data as object), [CTX_KEY]: serializeContext(ctx) } as T;
}

/**
 * Wraps a JobProcessor: detaches `_ctx` from the payload (so the user processor sees clean data)
 * and runs the processor inside the appropriate context.run / runAsSystem.
 */
export function wrapProcessorWithContext<T>(
  jobName: string,
  processor: JobProcessor<T>
): JobProcessor<T> {
  return async (job) => {
    const raw = job.data as T & { [CTX_KEY]?: unknown };
    const serialized = (raw as Record<string, unknown> | null)?.[CTX_KEY];
    const cleanData =
      raw && typeof raw === 'object'
        ? (() => {
            const { [CTX_KEY]: _omit, ...rest } = raw as Record<string, unknown>;
            return rest as T;
          })()
        : raw;

    const cleanJob = { ...job, data: cleanData };

    const ctx = serialized != null ? deserializeContext(serialized) : undefined;
    if (ctx) {
      await run(ctx, () => processor(cleanJob));
    } else {
      await runAsSystem(`bullmq-job:${jobName}`, () => processor(cleanJob));
    }
  };
}
