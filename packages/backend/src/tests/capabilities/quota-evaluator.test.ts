import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../database/index.js';
import { QuotaEvaluator } from '../../capabilities/quota-evaluator.js';
import { quotaFlagCache } from '../../capabilities/quota-cache.js';
import { capabilities } from '../../capabilities/facade.js';
import type { UsageRow, UsageAggregateParams } from '../../modules/metering/index.js';
import { createTestContext } from '../helpers/factories.js';

/** Stub matching the shape the evaluator depends on (aggregate + latestPointInTime). */
function makeMeteringStub(
  byOrgType: Record<string, Record<string, number>>,
  latestByOrgType: Record<string, Record<string, number>> = {}
) {
  return {
    async aggregate(params: UsageAggregateParams): Promise<UsageRow[]> {
      const forOrg = byOrgType[params.organizationId] ?? {};
      const entries = params.type
        ? (params.type in forOrg ? [[params.type, forOrg[params.type]]] : [])
        : Object.entries(forOrg);
      return entries.map(([type, quantity]) => ({
        type,
        project_id: null,
        quantity: quantity as number,
      }));
    },
    async latestPointInTime(organizationId: string, type: string): Promise<number> {
      return latestByOrgType[organizationId]?.[type] ?? 0;
    },
  };
}

describe('QuotaEvaluator', () => {
  let orgId: string;

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    quotaFlagCache.clear();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    capabilities.invalidate(orgId);
  });

  it('flags an org over quota when month-to-date usage >= limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'ingestion.max_events_monthly', enabled: null, limit_value: 100 })
      .execute();
    capabilities.invalidate(orgId);

    const stub = makeMeteringStub({ [orgId]: { 'logs.ingested.events': 150 } });
    const evaluator = new QuotaEvaluator(stub as any);

    await evaluator.runOnce();

    expect(quotaFlagCache.isOverQuota(orgId, 'ingestion.max_events_monthly')).toBe(true);
  });

  it('does not flag when usage is below the limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'ingestion.max_events_monthly', enabled: null, limit_value: 100 })
      .execute();
    capabilities.invalidate(orgId);

    const stub = makeMeteringStub({ [orgId]: { 'logs.ingested.events': 50 } });
    const evaluator = new QuotaEvaluator(stub as any);

    await evaluator.runOnce();

    expect(quotaFlagCache.isOverQuota(orgId, 'ingestion.max_events_monthly')).toBe(false);
  });

  it('skips orgs with all-null quota limits (no flag set)', async () => {
    // No entitlement rows: all quotas default to null (unlimited).
    const stub = makeMeteringStub({ [orgId]: { 'logs.ingested.events': 999999 } });
    const evaluator = new QuotaEvaluator(stub as any);

    await evaluator.runOnce();

    // Unset flag -> treated as under quota.
    expect(quotaFlagCache.isOverQuota(orgId, 'ingestion.max_events_monthly')).toBe(false);
  });

  it('isolates orgs: org A usage never flags org B', async () => {
    const other = await createTestContext();
    const orgB = other.organization.id;

    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'ingestion.max_events_monthly', enabled: null, limit_value: 10 })
      .execute();
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgB, capability: 'ingestion.max_events_monthly', enabled: null, limit_value: 10 })
      .execute();
    capabilities.invalidate(orgId);
    capabilities.invalidate(orgB);

    const stub = makeMeteringStub({ [orgId]: { 'logs.ingested.events': 50 } });
    const evaluator = new QuotaEvaluator(stub as any);

    await evaluator.runOnce();

    expect(quotaFlagCache.isOverQuota(orgId, 'ingestion.max_events_monthly')).toBe(true);
    expect(quotaFlagCache.isOverQuota(orgB, 'ingestion.max_events_monthly')).toBe(false);
  });

  it('leaves the flag unset (fail-open) when the metering read throws', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'ingestion.max_events_monthly', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);

    const throwingStub = {
      async aggregate(): Promise<UsageRow[]> {
        throw new Error('metering down');
      },
    };
    const evaluator = new QuotaEvaluator(throwingStub as any);

    await evaluator.runOnce();

    expect(quotaFlagCache.isOverQuota(orgId, 'ingestion.max_events_monthly')).toBe(false);
  });

  it('reads point_in_time quotas from the LATEST snapshot, not the aggregate sum', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'storage.max_bytes', enabled: null, limit_value: 1000 })
      .execute();
    capabilities.invalidate(orgId);

    // aggregate would say 5000 (historical sum) but the latest snapshot is 400:
    // the org must NOT be flagged. The evaluator must use latestPointInTime.
    const stub = makeMeteringStub(
      { [orgId]: { 'storage.snapshot': 5000 } },
      { [orgId]: { 'storage.snapshot': 400 } }
    );
    const evaluator = new QuotaEvaluator(stub as any);

    await evaluator.runOnce();

    expect(quotaFlagCache.isOverQuota(orgId, 'storage.max_bytes')).toBe(false);
  });

  it('flags a point_in_time quota when the latest snapshot exceeds the limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'storage.max_bytes', enabled: null, limit_value: 1000 })
      .execute();
    capabilities.invalidate(orgId);

    const stub = makeMeteringStub({}, { [orgId]: { 'storage.snapshot': 2500 } });
    const evaluator = new QuotaEvaluator(stub as any);

    await evaluator.runOnce();

    expect(quotaFlagCache.isOverQuota(orgId, 'storage.max_bytes')).toBe(true);
  });
});
