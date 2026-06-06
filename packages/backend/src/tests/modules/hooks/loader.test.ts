import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadExternalHooks } from '../../../hooks/loader.js';
import { HookRegistry } from '../../../hooks/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '../../fixtures/hooks');

describe('loadExternalHooks', () => {
  it('does nothing when the spec is empty/undefined', async () => {
    const registry = new HookRegistry();
    await loadExternalHooks(undefined, registry);
    await loadExternalHooks('', registry);
    expect(registry.hasHandlers('beforeIngest')).toBe(false);
  });

  it('loads a module and registers its hooks', async () => {
    const registry = new HookRegistry();
    await loadExternalHooks(path.join(fixturesDir, 'sample-hooks.mjs'), registry);
    expect(registry.hasHandlers('beforeIngest')).toBe(true);
    expect(registry.hasHandlers('beforeQuery')).toBe(true);
    expect(registry.hasHandlers('beforeWebhookDispatch')).toBe(false);
  });

  it('supports comma-separated lists with whitespace', async () => {
    const registry = new HookRegistry();
    const spec = ` ${path.join(fixturesDir, 'sample-hooks.mjs')} , `;
    await loadExternalHooks(spec, registry);
    expect(registry.hasHandlers('beforeIngest')).toBe(true);
  });

  it('loads multiple modules from a comma-separated list', async () => {
    const registry = new HookRegistry();
    const spec = `${path.join(fixturesDir, 'sample-hooks.mjs')},${path.join(fixturesDir, 'sample-hooks-2.mjs')}`;
    await loadExternalHooks(spec, registry);
    expect(registry.hasHandlers('beforeIngest')).toBe(true);
    expect(registry.hasHandlers('beforeWebhookDispatch')).toBe(true);
  });

  it('throws (fatal) on a missing module path', async () => {
    const registry = new HookRegistry();
    await expect(
      loadExternalHooks(path.join(fixturesDir, 'does-not-exist.mjs'), registry)
    ).rejects.toThrow();
  });

  it('throws (fatal) when the module has no default function export', async () => {
    const registry = new HookRegistry();
    await expect(
      loadExternalHooks(path.join(fixturesDir, 'bad-export.mjs'), registry)
    ).rejects.toThrow(/default-export a function/);
  });

  it('external modules can throw a real HookRejectionError via the helpers arg', async () => {
    const registry = new HookRegistry();
    await loadExternalHooks(path.join(fixturesDir, 'sample-hooks.mjs'), registry);
    await expect(
      registry.run('beforeIngest', {
        organizationId: 'org-1',
        projectId: 'proj-1',
        eventCount: 5000,
        byteSize: 1,
        records: [],
      })
    ).rejects.toMatchObject({
      name: 'HookRejectionError',
      code: 'policy.batch_too_large',
      statusCode: 429,
    });
  });
});
