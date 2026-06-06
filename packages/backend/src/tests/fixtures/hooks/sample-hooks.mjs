// Example external hooks module, as an operator would mount it.
// Default-exports a register function receiving the HookRegistry.
export default function register(hooks) {
  hooks.register('beforeIngest', async (ctx) => {
    if (ctx.eventCount > 1000) {
      // NOTE: a plain Error fails closed as HTTP 500. Real policies should
      // throw HookRejectionError(code, message, statusCode) for clean 4xx
      // rejections - plain Error is enough for this loader test.
      throw new Error('batch too large');
    }
  });
  hooks.register('beforeQuery', async () => {});
}
