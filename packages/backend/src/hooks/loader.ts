import path from 'path';
import { pathToFileURL } from 'url';
import { config } from '../config/index.js';
import { hooks } from './facade.js';
import type { HookRegistry } from './registry.js';

/**
 * Load external hook modules listed in HOOKS_MODULES (comma-separated paths,
 * typically volume-mounted into the container). Each module default-exports
 * `(hooks: HookRegistry) => void | Promise<void>`.
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
    const mod = await import(pathToFileURL(resolved).href);
    if (typeof mod.default !== 'function') {
      throw new Error(
        `[Hooks] Module ${resolved} must default-export a function (hooks: HookRegistry) => void`
      );
    }
    await mod.default(registry);
    console.log(`[Hooks] Loaded hooks module: ${resolved}`);
  }
}
