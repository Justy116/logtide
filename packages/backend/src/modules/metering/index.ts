import { MeteringRecorder } from './recorder.js';
import type { MeteringEvent } from './types.js';

/** Process-wide singleton recorder. Started in server.ts, stopped on shutdown. */
export const meteringRecorder = new MeteringRecorder();

/** Thin facade so callsites depend on `metering.record(...)`, not the recorder class. */
export const metering = {
  record(event: MeteringEvent): void {
    meteringRecorder.record(event);
  },
};

/**
 * Recording site helper for log ingestion. Fire-and-forget.
 * `logs` is the raw input batch; bytes are measured from its JSON serialization.
 */
export function recordLogIngestion(params: {
  logs: unknown[];
  eventCount: number;
  organizationId: string;
  projectId: string;
}): void {
  const bytes = Buffer.byteLength(JSON.stringify(params.logs));
  metering.record({
    type: 'logs.ingested.bytes',
    quantity: bytes,
    organizationId: params.organizationId,
    projectId: params.projectId,
  });
  metering.record({
    type: 'logs.ingested.events',
    quantity: params.eventCount,
    organizationId: params.organizationId,
    projectId: params.projectId,
  });
}

export { MeteringRecorder } from './recorder.js';
export { meteringService, MeteringService } from './service.js';
export type { MeteringEvent, MeteringEventType } from './types.js';
export type { UsageAggregateParams, UsageGroupBy, UsageRow } from './service.js';
export { usageRoutes } from './routes.js';
