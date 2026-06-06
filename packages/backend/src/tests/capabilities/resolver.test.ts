import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../database/index.js';
import { DbCapabilityResolver } from '../../capabilities/resolver.js';
import { createTestContext } from '../helpers/factories.js';

describe('DbCapabilityResolver', () => {
  let orgId: string;
  let resolver: DbCapabilityResolver;

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    resolver = new DbCapabilityResolver();
  });

  it('falls back to the registry default when no row exists', async () => {
    // auth.sso defaults to enabled; alerts.max_rules defaults to null (unlimited)
    expect(await resolver.has(orgId, 'auth.sso')).toBe(true);
    expect(await resolver.getLimit(orgId, 'alerts.max_rules')).toBeNull();
  });

  it('lets a stored row override the registry default', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'auth.sso', enabled: false, limit_value: null })
      .execute();
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'alerts.max_rules', enabled: null, limit_value: 3 })
      .execute();

    resolver.invalidate(orgId); // ensure fresh load
    expect(await resolver.has(orgId, 'auth.sso')).toBe(false);
    expect(await resolver.getLimit(orgId, 'alerts.max_rules')).toBe(3);
  });

  it('caches the merged map (a second call after a DB change still sees the cached value)', async () => {
    expect(await resolver.getLimit(orgId, 'alerts.max_rules')).toBeNull(); // warms cache

    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'alerts.max_rules', enabled: null, limit_value: 9 })
      .execute();

    // Without invalidate, still the cached null
    expect(await resolver.getLimit(orgId, 'alerts.max_rules')).toBeNull();

    resolver.invalidate(orgId);
    expect(await resolver.getLimit(orgId, 'alerts.max_rules')).toBe(9);
  });

  it('list() returns merged booleans and limits for the org', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'apikeys.max', enabled: null, limit_value: 2 })
      .execute();
    resolver.invalidate(orgId);

    const all = await resolver.list(orgId);
    expect(all['auth.sso']).toEqual({ kind: 'boolean', enabled: true });
    expect(all['apikeys.max']).toEqual({ kind: 'limit', limit: 2 });
    expect(all['ingestion.max_bytes_monthly']).toEqual({ kind: 'quota', limit: null });
  });

  it('has() on a non-boolean capability throws a developer error', async () => {
    await expect(resolver.has(orgId, 'alerts.max_rules' as any)).rejects.toThrow(/boolean/i);
  });

  it('getLimit() on a boolean capability throws a developer error', async () => {
    await expect(resolver.getLimit(orgId, 'auth.sso' as any)).rejects.toThrow(/limit|quota/i);
  });

  it('isolates organizations: org A entitlements never affect org B', async () => {
    const other = await createTestContext();
    const orgB = other.organization.id;

    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'auth.sso', enabled: false, limit_value: null })
      .execute();
    resolver.invalidate(orgId);

    expect(await resolver.has(orgId, 'auth.sso')).toBe(false);
    expect(await resolver.has(orgB, 'auth.sso')).toBe(true);
  });
});
