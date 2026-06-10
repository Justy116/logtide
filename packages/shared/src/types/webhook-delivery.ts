/** Lifecycle status of a logical webhook delivery. */
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

/** A logical delivery (one per enqueue), as returned by the API. */
export interface WebhookDelivery {
  id: string;
  organizationId: string;
  eventType: string;
  eventId: string;
  url: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** A single HTTP attempt against a delivery. */
export interface WebhookDeliveryAttempt {
  id: string;
  deliveryId: string;
  attemptNumber: number;
  statusCode: number | null;
  durationMs: number | null;
  responseExcerpt: string | null;
  error: string | null;
  createdAt: string;
}
