import { HookRegistry } from './registry.js';

/**
 * Process-wide singleton. Downstream distributions building from source can
 * import this and register handlers during their own bootstrap; container
 * deployments use HOOKS_MODULES (see loader.ts).
 */
export const hooks = new HookRegistry();
