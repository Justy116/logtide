import type { CapabilityName } from './registry.js';

/**
 * In-memory over-quota flag cache, maintained by the QuotaEvaluator and read by
 * assertWithinUsageQuota on the ingestion hot path. Per-backend-instance (each
 * instance runs its own evaluator). Unset flag => treated as under quota (fail-open).
 */
class QuotaFlagCache {
  private flags = new Map<string, Partial<Record<CapabilityName, boolean>>>();

  setOrgFlags(organizationId: string, flags: Partial<Record<CapabilityName, boolean>>): void {
    this.flags.set(organizationId, flags);
  }

  isOverQuota(organizationId: string, capability: CapabilityName): boolean {
    return this.flags.get(organizationId)?.[capability] === true;
  }

  clear(): void {
    this.flags.clear();
  }
}

export const quotaFlagCache = new QuotaFlagCache();
