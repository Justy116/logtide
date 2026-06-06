import type { HookPhase, HookContextMap, HookHandler } from './types.js';
import { HookRejectionError, HookExecutionError } from './errors.js';

type HandlerMap = { [P in HookPhase]: Array<HookHandler<P>> };

function emptyHandlerMap(): HandlerMap {
  return {
    beforeIngest: [],
    beforeQuery: [],
    beforeAlertEvaluation: [],
    beforeWebhookDispatch: [],
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
    (this.handlers[phase] as Array<HookHandler<P>>).push(handler);
  }

  hasHandlers(phase: HookPhase): boolean {
    return this.handlers[phase].length > 0;
  }

  async run<P extends HookPhase>(phase: P, ctx: HookContextMap[P]): Promise<void> {
    const list = this.handlers[phase] as Array<HookHandler<P>>;
    if (list.length === 0) return;
    for (const handler of list) {
      try {
        await handler(ctx);
      } catch (err) {
        if (err instanceof HookRejectionError) throw err;
        console.error(`[Hooks] Handler failed in phase ${phase}:`, err);
        throw new HookExecutionError(phase);
      }
    }
  }

  /** Test-only: wipe all registrations. */
  clear(): void {
    this.handlers = emptyHandlerMap();
  }
}
