import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../database/index.js';
import { context } from '@logtide/shared/context';
import { assertWithinUsageQuota } from '../../capabilities/enforce.js';
import { QuotaExceededError } from '../../capabilities/errors.js';
import { quotaFlagCache } from '../../capabilities/quota-cache.js';
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

describe('assertWithinUsageQuota', () => {
  let orgId: string;

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    quotaFlagCache.clear();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    capabilities.invalidate(orgId);
  });

  it('allows when the over-quota flag is unset (fail-open)', async () => {
    await asOrg(orgId, async () => {
      await expect(assertWithinUsageQuota('ingestion.max_bytes_monthly')).resolves.toBeUndefined();
    });
  });

  it('is a no-op when the configured limit is null (unlimited), even if flagged', async () => {
    // No entitlement row -> limit null. Flag should never be set in that case,
    // but assert the helper also short-circuits on a null limit defensively.
    quotaFlagCache.setOrgFlags(orgId, { 'ingestion.max_bytes_monthly': true });
    await asOrg(orgId, async () => {
      await expect(assertWithinUsageQuota('ingestion.max_bytes_monthly')).resolves.toBeUndefined();
    });
  });

  it('throws QuotaExceededError (429) when flagged over and a limit is set', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'ingestion.max_bytes_monthly', enabled: null, limit_value: 1000 })
      .execute();
    capabilities.invalidate(orgId);
    quotaFlagCache.setOrgFlags(orgId, { 'ingestion.max_bytes_monthly': true });

    await asOrg(orgId, async () => {
      try {
        await assertWithinUsageQuota('ingestion.max_bytes_monthly');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(QuotaExceededError);
        expect((e as QuotaExceededError).statusCode).toBe(429);
        expect((e as QuotaExceededError).code).toBe('capability.ingestion.max_bytes_monthly.exceeded');
        expect((e as QuotaExceededError).capability).toBe('ingestion.max_bytes_monthly');
      }
    });
  });
});
