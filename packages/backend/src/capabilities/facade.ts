import {
  DbCapabilityResolver,
  type CapabilityResolver,
  type EntitlementValue,
} from './resolver.js';
import type { CapabilityName } from './registry.js';

let activeResolver: CapabilityResolver = new DbCapabilityResolver();

/**
 * Swap the resolver before the server starts. A downstream distribution (hosted
 * service) can source entitlements from subscription/license state without
 * patching core. Must be called during boot, before any request is served.
 */
export function setCapabilityResolver(resolver: CapabilityResolver): void {
  activeResolver = resolver;
}

export function getCapabilityResolver(): CapabilityResolver {
  return activeResolver;
}

/** Singleton facade delegating to whatever resolver is registered. */
export const capabilities = {
  has(organizationId: string, capability: CapabilityName): Promise<boolean> {
    return activeResolver.has(organizationId, capability);
  },
  getLimit(organizationId: string, capability: CapabilityName): Promise<number | null> {
    return activeResolver.getLimit(organizationId, capability);
  },
  list(organizationId: string): Promise<Record<CapabilityName, EntitlementValue>> {
    return activeResolver.list(organizationId);
  },
  invalidate(organizationId: string): void {
    activeResolver.invalidate(organizationId);
  },
};
