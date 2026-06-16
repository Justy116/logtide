import { getApiUrl } from '$lib/config';
import { getAuthToken } from '$lib/utils/auth';
import type { WebhookDelivery, WebhookDeliveryAttempt, WebhookDeliveryStatus } from '@logtide/shared';

async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const headers: HeadersInit = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  return fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });
}

// snake_case row shapes returned by the backend
interface DeliveryRow {
  id: string;
  organization_id: string;
  event_type: string;
  event_id: string;
  url: string;
  status: WebhookDeliveryStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  delivery_id: string;
  attempt_number: number;
  status_code: number | null;
  duration_ms: number | null;
  response_excerpt: string | null;
  error: string | null;
  created_at: string;
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventType: row.event_type,
    eventId: row.event_id,
    url: row.url,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttempt(row: AttemptRow): WebhookDeliveryAttempt {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    attemptNumber: row.attempt_number,
    statusCode: row.status_code,
    durationMs: row.duration_ms,
    responseExcerpt: row.response_excerpt,
    error: row.error,
    createdAt: row.created_at,
  };
}

export async function listWebhookDeliveries(params: {
  organizationId: string;
  status?: WebhookDeliveryStatus;
  limit?: number;
  offset?: number;
}): Promise<WebhookDelivery[]> {
  const qs = new URLSearchParams({ organizationId: params.organizationId });
  if (params.status) qs.set('status', params.status);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));

  const response = await fetchWithAuth(`${getApiUrl()}/api/v1/webhooks/deliveries?${qs}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to fetch deliveries' }));
    throw new Error((error as { error?: string }).error || 'Failed to fetch deliveries');
  }

  const data = await response.json();
  return (data.deliveries as DeliveryRow[]).map(toDelivery);
}

export async function getWebhookDelivery(
  id: string
): Promise<{ delivery: WebhookDelivery; attempts: WebhookDeliveryAttempt[] }> {
  const response = await fetchWithAuth(`${getApiUrl()}/api/v1/webhooks/deliveries/${id}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to fetch delivery' }));
    throw new Error((error as { error?: string }).error || 'Failed to fetch delivery');
  }

  const data = await response.json();
  return {
    delivery: toDelivery(data.delivery as DeliveryRow),
    attempts: (data.attempts as AttemptRow[]).map(toAttempt),
  };
}

export async function replayWebhookDelivery(id: string): Promise<WebhookDelivery> {
  const response = await fetchWithAuth(`${getApiUrl()}/api/v1/webhooks/deliveries/${id}/replay`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to replay delivery' }));
    throw new Error((error as { error?: string }).error || 'Failed to replay delivery');
  }

  const data = await response.json();
  return toDelivery(data.delivery as DeliveryRow);
}
