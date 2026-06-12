import { getApiBaseUrl } from '$lib/config';
import { getAuthToken } from '$lib/utils/auth';

export type AuditCategory = 'log_access' | 'config_change' | 'user_management' | 'data_modification';
export type AuditActorType = 'user' | 'apiKey' | 'system';
export type AuditOutcome = 'success' | 'failure';

export interface AuditLogEntry {
  id: string;
  time: string;
  organization_id: string | null;
  user_id: string | null;
  user_email: string | null;
  actor_type: AuditActorType;
  actor_id: string | null;
  outcome: AuditOutcome;
  action: string;
  category: AuditCategory;
  resource_type: string | null;
  resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AuditLogFilters {
  organizationId: string;
  category?: AuditCategory;
  action?: string;
  resourceType?: string;
  userId?: string;
  actorType?: AuditActorType;
  outcome?: AuditOutcome;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogResponse {
  entries: AuditLogEntry[];
  total: number;
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
    throw new Error((err as any).error ?? `HTTP ${response.status}`);
  }

  return response;
}

export async function getAuditLog(filters: AuditLogFilters): Promise<AuditLogResponse> {
  const params = new URLSearchParams({ organizationId: filters.organizationId });

  if (filters.category) params.set('category', filters.category);
  if (filters.action) params.set('action', filters.action);
  if (filters.resourceType) params.set('resourceType', filters.resourceType);
  if (filters.userId) params.set('userId', filters.userId);
  if (filters.actorType) params.set('actorType', filters.actorType);
  if (filters.outcome) params.set('outcome', filters.outcome);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.limit != null) params.set('limit', String(filters.limit));
  if (filters.offset != null) params.set('offset', String(filters.offset));

  const response = await request(`/audit-log?${params}`);
  return response.json();
}

export async function getAuditLogActions(organizationId: string): Promise<string[]> {
  const response = await request(`/audit-log/actions?organizationId=${organizationId}`);
  const data = await response.json();
  return data.actions;
}

export interface AuditLogExportFilters {
  organizationId: string;
  category?: AuditCategory;
  action?: string;
  actorType?: AuditActorType;
  outcome?: AuditOutcome;
  from?: string;
  to?: string;
}

export async function exportAuditLogCsv(filters: AuditLogExportFilters): Promise<void> {
  const params = new URLSearchParams({ organizationId: filters.organizationId });
  if (filters.category) params.set('category', filters.category);
  if (filters.action) params.set('action', filters.action);
  if (filters.actorType) params.set('actorType', filters.actorType);
  if (filters.outcome) params.set('outcome', filters.outcome);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);

  const response = await request(`/audit-log/export?${params}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
