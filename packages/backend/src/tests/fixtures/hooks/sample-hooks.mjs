// Example external hooks module, as an operator would mount it.
// Default-exports a register function receiving the HookRegistry.
export default function register(hooks) {
  hooks.register('beforeIngest', async (ctx) => {
    if (ctx.eventCount > 1000) {
      // operators would use HookRejectionError from their own copy of the
      // contract; plain Error is enough for the loader test
      throw new Error('batch too large');
    }
  });
  hooks.register('beforeQuery', async () => {});
}
