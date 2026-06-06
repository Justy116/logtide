// Second fixture: proves multi-module loading iterates past the first entry.
export default function register(hooks) {
  hooks.register('beforeWebhookDispatch', async () => {});
}
