import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../database/index.js';
import { context } from '@logtide/shared/context';
import {
  assertCapability,
  assertWithinLimit,
} from '../../capabilities/enforce.js';
import { CapabilityError } from '../../capabilities/errors.js';
import { capabilities } from '../../capabilities/facade.js';
import { createTestContext } from '../helpers/factories.js';

function asOrg<T>(orgId: string, fn: () => Promise<T> | T): Promise<T> {
  return context.run(
    {
      requestId: 'test',
      origin: 'http',
      actor: { type: 'system', id: null },
      organizationId: orgId,
      projectId: null,
    },
    fn
  );
}

describe('enforcement helpers (boolean + static limit)', () => {
  let orgId: string;

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    capabilities.invalidate(orgId);
  });

  it('assertCapability allows when the boolean gate is enabled (default)', async () => {
    await asOrg(orgId, async () => {
      await expect(assertCapability('auth.sso')).resolves.toBeUndefined();
    });
  });

  it('assertCapability throws CapabilityError (403) when the gate is disabled', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'auth.sso', enabled: false, limit_value: null })
      .execute();
    capabilities.invalidate(orgId);

    await asOrg(orgId, async () => {
      try {
        await assertCapability('auth.sso');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CapabilityError);
        expect((e as CapabilityError).statusCode).toBe(403);
        expect((e as CapabilityError).code).toBe('capability.auth.sso.denied');
        expect((e as CapabilityError).capability).toBe('auth.sso');
      }
    });
  });

  it('assertWithinLimit is a no-op when the limit is null (unlimited)', async () => {
    await asOrg(orgId, async () => {
      await expect(assertWithinLimit('alerts.max_rules', 9999)).resolves.toBeUndefined();
    });
  });

  it('assertWithinLimit allows when current count is below the cap', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'alerts.max_rules', enabled: null, limit_value: 5 })
      .execute();
    capabilities.invalidate(orgId);

    await asOrg(orgId, async () => {
      await expect(assertWithinLimit('alerts.max_rules', 4)).resolves.toBeUndefined();
    });
  });

  it('assertWithinLimit throws CapabilityError at the cap (count === limit)', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'alerts.max_rules', enabled: null, limit_value: 5 })
      .execute();
    capabilities.invalidate(orgId);

    await asOrg(orgId, async () => {
      try {
        await assertWithinLimit('alerts.max_rules', 5);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CapabilityError);
        expect((e as CapabilityError).statusCode).toBe(403);
        expect((e as CapabilityError).code).toBe('capability.alerts.max_rules.limit_reached');
      }
    });
  });

  it('reads the org from context.current()', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'alerts.max_rules', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);

    // Without a context org, helpers must throw a clear developer error.
    await expect(assertWithinLimit('alerts.max_rules', 1)).rejects.toThrow();
  });
});

describe('assertWithinLimit bulk adding', () => {
  let orgId: string;

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    capabilities.invalidate(orgId);
  });

  it('passes when currentCount + adding stays within the limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'sigma.max_active_rules', enabled: null, limit_value: 10 })
      .execute();
    capabilities.invalidate(orgId);

    await asOrg(orgId, async () => {
      await expect(assertWithinLimit('sigma.max_active_rules', 5, 5)).resolves.toBeUndefined();
    });
  });

  it('throws when currentCount + adding exceeds the limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'sigma.max_active_rules', enabled: null, limit_value: 10 })
      .execute();
    capabilities.invalidate(orgId);

    await asOrg(orgId, async () => {
      await expect(assertWithinLimit('sigma.max_active_rules', 5, 6)).rejects.toMatchObject({
        statusCode: 403,
        code: 'capability.sigma.max_active_rules.limit_reached',
      });
    });
  });

  it('default adding=1 preserves existing semantics', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'sigma.max_active_rules', enabled: null, limit_value: 3 })
      .execute();
    capabilities.invalidate(orgId);

    await asOrg(orgId, async () => {
      await expect(assertWithinLimit('sigma.max_active_rules', 3)).rejects.toMatchObject({ statusCode: 403 });
      await expect(assertWithinLimit('sigma.max_active_rules', 2)).resolves.toBeUndefined();
    });
  });
});
