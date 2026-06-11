import type { HookPhase, BeforeHookPhase, AfterHookPhase, HookContextMap, HookHandler } from './types.js';
import { HookRejectionError, HookExecutionError } from './errors.js';

type HandlerMap = { [P in HookPhase]: Array<HookHandler<P>> };

function emptyHandlerMap(): HandlerMap {
  return {
    beforeIngest: [],
    beforeQuery: [],
    beforeAlertEvaluation: [],
    beforeWebhookDispatch: [],
    afterIngest: [],
    afterAlertTriggered: [],
    afterWebhookDispatch: [],
  };
}

/**
 * Typed lifecycle hook registry (#216). Handlers run sequentially in
 * registration order; the first throw short-circuits the phase.
 * HookRejectionError propagates as-is; anything else is wrapped in
 * HookExecutionError (fail-closed) with the original logged server-side.
 */
export class HookRegistry {
  private handlers: HandlerMap = emptyHandlerMap();

  register<P extends HookPhase>(phase: P, handler: HookHandler<P>): void {
    // TS cannot correlate handlers[phase] with HookHandler<P> through a generic key
    (this.handlers[phase] as Array<HookHandler<P>>).push(handler);
  }

  hasHandlers(phase: HookPhase): boolean {
    return this.handlers[phase].length > 0;
  }

  /**
   * Run before-phase handlers. Handler errors are propagated (fail-closed):
   * HookRejectionError as-is, others wrapped in HookExecutionError.
   * Restricted to BeforeHookPhase at the type level; use runAfter for
   * after-* phases.
   */
  async run<P extends BeforeHookPhase>(phase: P, ctx: HookContextMap[P]): Promise<void> {
    const list = this.handlers[phase] as Array<HookHandler<P>>;
    if (list.length === 0) return;
    for (const handler of list) {
      try {
        await handler(ctx);
      } catch (err) {
        if (err instanceof HookRejectionError) throw err;
        console.error(`[Hooks] Handler failed in phase ${phase}:`, err);
        throw new HookExecutionError(phase, err);
      }
    }
  }

  /**
   * Run after-phase handlers: fire-and-forget semantics. Handler errors are
   * logged and swallowed; the context is frozen (after-hooks observe, never
   * mutate). Callers should guard with hasHandlers() to keep hot paths free.
   */
  async runAfter<P extends AfterHookPhase>(phase: P, context: HookContextMap[P]): Promise<void> {
    const frozen = Object.freeze(context) as HookContextMap[P];
    for (const handler of this.handlers[phase] as Array<HookHandler<P>>) {
      try {
        await handler(frozen);
      } catch (err) {
        console.warn(`[Hooks] ${phase} handler failed:`, err);
      }
    }
  }

  /** Test-only: wipe all registrations. */
  clear(): void {
    this.handlers = emptyHandlerMap();
  }
}
