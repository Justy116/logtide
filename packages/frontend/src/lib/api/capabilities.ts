import { getApiBaseUrl } from '$lib/config';
import { getAuthToken } from '$lib/utils/auth';

export type EntitlementValue =
  | { kind: 'boolean'; enabled: boolean }
  | { kind: 'limit'; limit: number | null }
  | { kind: 'quota'; limit: number | null };

export type CapabilityMap = Record<string, EntitlementValue>;

/**
 * Fetch the merged capability set (booleans, static limits, quota caps) for an org.
 * Caps only, not live usage. Use to gate UI for disabled/over-limit features.
 */
export async function listCapabilities(organizationId: string): Promise<CapabilityMap> {
  const token = getAuthToken();
  const params = new URLSearchParams({ organizationId });
  const response = await fetch(`${getApiBaseUrl()}/capabilities?${params.toString()}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${response.status}`);
  }

  const body = (await response.json()) as { capabilities: CapabilityMap };
  return body.capabilities;
}
