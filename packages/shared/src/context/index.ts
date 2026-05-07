export * from './types.js';
export {
  contextStorage,
  run,
  enterWith,
  current,
  currentOrNull,
  withPatch as with_,
  runAsSystem,
} from './storage.js';
export { serializeContext, deserializeContext } from './serialize.js';
export { fetchWithContext } from './fetch.js';
export { withContext } from './test-helpers.js';

import * as storage from './storage.js';
import { serializeContext, deserializeContext } from './serialize.js';

/**
 * Convenience namespace mirroring the design spec API.
 * Use `context.current()`, `context.run()`, etc.
 */
export const context = {
  run: storage.run,
  enterWith: storage.enterWith,
  current: storage.current,
  currentOrNull: storage.currentOrNull,
  with: storage.withPatch,
  runAsSystem: storage.runAsSystem,
  serialize: serializeContext,
  deserialize: deserializeContext,
} as const;
