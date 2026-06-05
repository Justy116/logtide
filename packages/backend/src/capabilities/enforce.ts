import { context } from '@logtide/shared/context';
import { capabilities } from './facade.js';
import { CapabilityError } from './errors.js';
import type { CapabilityName } from './registry.js';

/** Read the current org from request context, or throw a clear developer error. */
function currentOrgId(): string {
  const ctx = context.current();
  if (!ctx.organizationId) {
    throw new Error(
      'Capability enforcement requires an organization in the request context (context.current().organizationId is null)'
    );
  }
  return ctx.organizationId;
}

/**
 * Boolean gate. Throws CapabilityError (403) when the capability is disabled
 * for the current org. Reads the org from context.current().
 */
export async function assertCapability(capability: CapabilityName): Promise<void> {
  const orgId = currentOrgId();
  const allowed = await capabilities.has(orgId, capability);
  if (!allowed) {
    throw new CapabilityError(
      `capability.${capability}.denied`,
      `Feature '${capability}' is not enabled for this organization`,
      capability
    );
  }
}

/**
 * Static numeric cap. Caller supplies the current count (a cheap COUNT(*)).
 * No-op when the limit is null (unlimited). Throws CapabilityError (403) when
 * currentCount >= limit. Reads the org from context.current().
 */
export async function assertWithinLimit(
  capability: CapabilityName,
  currentCount: number
): Promise<void> {
  const orgId = currentOrgId();
  const limit = await capabilities.getLimit(orgId, capability);
  if (limit === null) return; // unlimited
  if (currentCount >= limit) {
    throw new CapabilityError(
      `capability.${capability}.limit_reached`,
      `Limit reached for '${capability}' (${currentCount}/${limit})`,
      capability
    );
  }
}
