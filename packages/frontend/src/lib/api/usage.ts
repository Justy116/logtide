import { getApiBaseUrl } from '$lib/config';
import { getAuthToken } from '$lib/utils/auth';

export type UsageGroupBy = 'type' | 'project' | 'day';

export interface UsageRecord {
  type: string;
  project_id: string | null;
  bucket?: string;
  quantity: number;
}

export interface UsageResponse {
  usage: UsageRecord[];
}

export interface UsageParams {
  organizationId: string;
  from: string;
  to: string;
  groupBy: UsageGroupBy;
  type?: string;
}

async function request(endpoint: string): Promise<Response> {
  const token = getAuthToken();
  const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${response.status}`);
  }

  return response;
}

export async function getUsage(params: UsageParams): Promise<UsageResponse> {
  const p = new URLSearchParams({
    organizationId: params.organizationId,
    from: params.from,
    to: params.to,
    groupBy: params.groupBy,
  });
  if (params.type) p.set('type', params.type);

  const response = await request(`/usage?${p}`);
  return response.json();
}

export interface TypeUsage {
  type: string;
  quantity: number;
}

export interface ProjectUsage {
  projectId: string;
  projectName: string;
  events: number;
  bytes: number;
}

export interface ValueCount {
  value: string;
  count: number;
}

export interface UsageBreakdown {
  byType: TypeUsage[];
  byProject: ProjectUsage[];
  byService: ValueCount[];
  byLevel: ValueCount[];
}

export interface BreakdownResponse {
  breakdown: UsageBreakdown;
}

export interface BreakdownParams {
  organizationId: string;
  from: string;
  to: string;
}

export async function getUsageBreakdown(params: BreakdownParams): Promise<BreakdownResponse> {
  const p = new URLSearchParams({
    organizationId: params.organizationId,
    from: params.from,
    to: params.to,
  });

  const response = await request(`/usage/breakdown?${p}`);
  return response.json();
}
