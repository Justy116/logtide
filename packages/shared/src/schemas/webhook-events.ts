import { z } from 'zod';

export const webhookEventTypeSchema = z.enum([
  'alert.triggered',
  'incident.created',
  'error.detected',
  'monitor.status_changed',
  'channel.test',
]);
export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>;

const organizationRefSchema = z.object({ id: z.string().uuid(), name: z.string() });

export const alertTriggeredDataSchema = z
  .object({
    alert_name: z.string(),
    log_count: z.number(),
    threshold: z.number(),
    time_window: z.number(),
    baseline_metadata: z
      .object({
        baseline_value: z.number(),
        current_value: z.number(),
        deviation_ratio: z.number(),
        baseline_type: z.string(),
        evaluation_time: z.string(),
      })
      .nullable(),
    link: z.string(),
  })
  .passthrough();

export const errorDetectedDataSchema = z
  .object({
    title: z.string(),
    message: z.string(),
    severity: z.string(),
    organization: organizationRefSchema,
    // project is always sent by the producer; id may be null (ErrorNotificationJobData.projectId)
    project: z.object({ id: z.string().uuid().nullable(), name: z.string() }),
    error_group_id: z.string(),
    exception_type: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    service: z.string().nullable().optional(),
    is_new: z.boolean(),
    link: z.string(),
  })
  .passthrough();

export const monitorStatusChangedDataSchema = z
  .object({
    monitor_id: z.string(),
    monitor_name: z.string(),
    status: z.string(),
    severity: z.string(),
    title: z.string(),
    message: z.string(),
    organization: organizationRefSchema,
    target: z.string().optional(),
    error_code: z.string().nullable().optional(),
    response_time_ms: z.number().nullable().optional(),
    consecutive_failures: z.number().optional(),
    downtime_duration: z.string().nullable().optional(),
    link: z.string(),
  })
  .passthrough();

export const incidentCreatedDataSchema = z
  .object({
    title: z.string(),
    message: z.string(),
    severity: z.string(),
    organization: organizationRefSchema,
    incident_id: z.string(),
    affected_services: z.array(z.string()).optional(),
    link: z.string(),
  })
  .passthrough();

// channel.test uses the WebhookProvider generic payload where organizationId can be
// a non-uuid string (e.g. 'test' from the test() method) so organization.id is z.string()
export const channelNotificationDataSchema = z
  .object({
    title: z.string(),
    message: z.string(),
    severity: z.string().optional(),
    organization: z.object({ id: z.string(), name: z.string() }).optional(),
    link: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const webhookEnvelopeSchema = z.object({
  id: z.string().regex(/^evt_[0-9a-f-]{36}$/),
  type: webhookEventTypeSchema,
  version: z.literal(1),
  occurredAt: z.string().datetime(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  data: z.record(z.unknown()),
});
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

export const WEBHOOK_EVENT_DATA_SCHEMAS = {
  'alert.triggered': alertTriggeredDataSchema,
  'incident.created': incidentCreatedDataSchema,
  'error.detected': errorDetectedDataSchema,
  'monitor.status_changed': monitorStatusChangedDataSchema,
  'channel.test': channelNotificationDataSchema,
} as const;

/** Parse an envelope AND validate its per-type data schema. */
export function parseWebhookEvent(input: unknown): WebhookEnvelope {
  const envelope = webhookEnvelopeSchema.parse(input);
  WEBHOOK_EVENT_DATA_SCHEMAS[envelope.type].parse(envelope.data);
  return envelope;
}
