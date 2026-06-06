// Example external hooks module, as an operator would mount it.
// Default-exports a register function receiving (registry, helpers).
export default function register(hooks, { HookRejectionError }) {
  hooks.register('beforeIngest', async (ctx) => {
    if (ctx.eventCount > 1000) {
      // Throwing HookRejectionError surfaces a clean 4xx with a machine-
      // readable code; any other error fails closed as HTTP 500.
      throw new HookRejectionError('policy.batch_too_large', 'batch too large', 429);
    }
  });
  hooks.register('beforeQuery', async () => {});
}
