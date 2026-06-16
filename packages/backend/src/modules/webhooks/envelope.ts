import { randomUUID } from 'crypto';
import type { WebhookEnvelope, WebhookEventType } from '@logtide/shared';

/** Build the unified outbound webhook event envelope (version 1). */
export function buildEnvelope(params: {
  type: WebhookEventType;
  organizationId: string;
  projectId?: string | null;
  data: Record<string, unknown>;
}): WebhookEnvelope {
  return {
    id: `evt_${randomUUID()}`,
    type: params.type,
    version: 1,
    occurredAt: new Date().toISOString(),
    organizationId: params.organizationId,
    projectId: params.projectId ?? null,
    data: params.data,
  };
}
