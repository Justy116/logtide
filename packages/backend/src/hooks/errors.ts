import type { HookPhase } from './types.js';

/**
 * Intentional rejection thrown by a registered hook to abort the operation.
 * Carries a machine-readable code; the global error handler in server.ts
 * surfaces statusCode + code + message on 4xx (same path as CapabilityError).
 */
export class HookRejectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 403
  ) {
    super(message);
    this.name = 'HookRejectionError';
  }
}

/**
 * A hook threw something other than HookRejectionError. Fail-closed: the
 * operation aborts with a 500 and the original error is logged server-side,
 * never exposed to the client.
 */
export class HookExecutionError extends Error {
  readonly code = 'hook.execution_failed';
  readonly statusCode = 500;
  constructor(public readonly phase: HookPhase) {
    super(`Hook execution failed in phase ${phase}`);
    this.name = 'HookExecutionError';
  }
}
