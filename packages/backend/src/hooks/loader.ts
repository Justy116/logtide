import path from 'path';
import { pathToFileURL } from 'url';
import { config } from '../config/index.js';
import { hooks } from './facade.js';
import type { HookRegistry } from './registry.js';
import { HookRejectionError } from './errors.js';

/**
 * Helpers handed to external modules so they can construct typed errors
 * without importing backend internals.
 */
export interface HookModuleHelpers {
  HookRejectionError: typeof HookRejectionError;
}

const moduleHelpers: HookModuleHelpers = { HookRejectionError };

/**
 * Load external hook modules listed in HOOKS_MODULES (comma-separated paths,
 * typically volume-mounted into the container). Each module default-exports
 * `(hooks: HookRegistry, helpers: HookModuleHelpers) => void | Promise<void>`
 * (the second argument is optional for modules that only observe/mutate).
 *
 * Any failure (missing file, bad export, register() throwing) is FATAL at
 * boot: operator policy that silently fails to load is worse than a crash.
 */
export async function loadExternalHooks(
  modulesSpec: string | undefined = config.HOOKS_MODULES,
  registry: HookRegistry = hooks
): Promise<void> {
  if (!modulesSpec) return;
  const paths = modulesSpec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  for (const modulePath of paths) {
    const resolved = path.resolve(modulePath);
    let mod: { default?: unknown };
    try {
      mod = await import(pathToFileURL(resolved).href);
    } catch (err) {
      throw new Error(
        `[Hooks] Failed to load module ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    if (typeof mod.default !== 'function') {
      throw new Error(
        `[Hooks] Module ${resolved} must default-export a function (hooks: HookRegistry) => void`
      );
    }
    await (mod.default as (r: HookRegistry, h: HookModuleHelpers) => void | Promise<void>)(
      registry,
      moduleHelpers
    );
    console.log(`[Hooks] Loaded hooks module: ${resolved}`);
  }
}
