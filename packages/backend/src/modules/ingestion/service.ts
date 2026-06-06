import { db } from '../../database/index.js';
import { reservoir } from '../../database/reservoir.js';
import type { LogLevel as ReservoirLogLevel } from '@logtide/reservoir';
import type { LogInput } from '@logtide/shared';
import { createQueue } from '../../queue/connection.js';
import type { LogEntry } from '../sigma/detection-engine.js';
import { CacheManager } from '../../utils/cache.js';
import { notificationPublisher } from '../streaming/index.js';
import { correlationService, type IdentifierMatch } from '../correlation/service.js';
import { piiMaskingService } from '../pii-masking/service.js';
import { projectsService } from '../projects/service.js';
import { extractHostname } from './routes.js';
import { recordLogIngestion } from '../metering/index.js';
import { assertWithinUsageQuota } from '../../capabilities/index.js';
import { context } from '@logtide/shared/context';

/**
 * Remove null characters (\u0000) that PostgreSQL doesn't support in text fields.
 */
function sanitizeForPostgres<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.replace(/\u0000/g, '') as T;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForPostgres) as T;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = sanitizeForPostgres(v);
    }
    return result as T;
  }
  return value;
}

export class IngestionService {
  /**
   * Ingest logs in batch
   */
  async ingestLogs(logs: LogInput[], projectId: string): Promise<number> {
    if (logs.length === 0) {
      return 0;
    }

    // Get project to find organization_id for custom patterns
    const project = await db
      .selectFrom('projects')
      .select(['organization_id'])
      .where('id', '=', projectId)
      .executeTakeFirst();

    const organizationId = project?.organization_id;

    // Extract identifiers from logs before insertion (using org-specific patterns)
    // Note: org_id and project_id are excluded from extraction to avoid storing useless data
    const identifiersByLog = new Map<number, IdentifierMatch[]>();
    for (let i = 0; i < logs.length; i++) {
      try {
        const identifiers = organizationId
          ? await correlationService.extractIdentifiersAsync(logs[i], organizationId, projectId)
          : correlationService.extractIdentifiers(logs[i], new Set([projectId.toLowerCase()]));
        if (identifiers.length > 0) {
          identifiersByLog.set(i, identifiers);
        }
      } catch (err) {
        // Don't fail ingestion if identifier extraction fails
        console.warn('[Ingestion] Failed to extract identifiers from log:', err);
      }
    }

    // PII masking: apply before DB insert so sensitive data never touches disk
    if (organizationId) {
      try {
        await piiMaskingService.maskLogBatch(logs, organizationId, projectId);
      } catch (err) {
        // Don't fail ingestion if PII masking fails
        console.warn('[Ingestion] PII masking failed, proceeding with unmasked data:', err);
      }
    }

    // Capability: hard-block ingestion when over a usage quota (#214).
    // Reads only the in-memory over-quota flag (no DB on the hot path).
    // Guarded by organizationId AND a live context: anonymous/missing-org ingestion is never blocked.
    if (organizationId && context.currentOrNull()?.organizationId) {
      await assertWithinUsageQuota('ingestion.max_bytes_monthly');
      await assertWithinUsageQuota('ingestion.max_events_monthly');
      await assertWithinUsageQuota('storage.max_bytes');
    }

    // Convert logs to reservoir LogRecord format
    // Note: reservoir handles null byte sanitization internally
    const records = logs.map((log) => {
      // Extract hostname if not already set in metadata
      const hostname = log.metadata?.hostname || extractHostname(log);
      
      const metadata = {
        ...log.metadata,
        ...(hostname && { hostname }),
      };

      const hasMetadata = Object.keys(metadata).length > 0;

      return {
        time: typeof log.time === 'string' ? new Date(log.time) : log.time,
        projectId,
        service: sanitizeForPostgres(log.service),
        level: log.level as ReservoirLogLevel,
        message: sanitizeForPostgres(log.message),
        metadata: hasMetadata ? sanitizeForPostgres(metadata) : undefined,
        traceId: sanitizeForPostgres(log.trace_id) || undefined,
        spanId: sanitizeForPostgres((log as { span_id?: string }).span_id) || undefined,
        sessionId: sanitizeForPostgres((log as { session_id?: string }).session_id) || undefined,
      };
    });

    // Insert via reservoir (raw parametrized SQL with RETURNING *)
    const ingestResult = await reservoir.ingestReturning(records);
    const insertedLogs = ingestResult.rows.map((row: { id: string; time: Date; projectId: string; service: string; level: string; message: string; metadata?: Record<string, unknown>; traceId?: string; spanId?: string; sessionId?: string }) => ({
      id: row.id,
      time: row.time,
      project_id: row.projectId,
      service: row.service,
      level: row.level,
      message: row.message,
      metadata: row.metadata,
      trace_id: row.traceId,
      span_id: row.spanId,
      session_id: row.sessionId,
    }));

    // Store extracted identifiers (async, non-blocking)
    if (identifiersByLog.size > 0) {
      this.storeIdentifiers(insertedLogs, identifiersByLog, projectId).catch((err) => {
        console.error('[Ingestion] Failed to store identifiers:', err);
      });
    }

    // Trigger Sigma detection (async, non-blocking) with log IDs
    this.triggerSigmaDetection(logs, insertedLogs, projectId).catch((err) => {
      console.error('[Ingestion] Failed to trigger Sigma detection:', err);
    });

    // Trigger Exception parsing for error/critical logs (async, non-blocking)
    this.triggerExceptionParsing(logs, insertedLogs, projectId).catch((err) => {
      console.error('[Ingestion] Failed to trigger Exception parsing:', err);
    });

    // Trigger pipeline processing (async, non-blocking)
    if (organizationId) {
      this.triggerPipelineProcessing(logs, insertedLogs, projectId, organizationId).catch((err) => {
        console.error('[Ingestion] Failed to trigger pipeline processing:', err);
      });
    }

    // Mark the project as having logs (debounced in-memory, fire-and-forget)
    projectsService.markHasData(projectId, 'logs').catch(() => {});

    // Invalidate query caches for this project (async, non-blocking)
    CacheManager.invalidateProjectQueries(projectId).catch((err) => {
      console.error('[Ingestion] Failed to invalidate cache:', err);
    });

    // Publish notification for live tail (uses PostgreSQL LISTEN/NOTIFY)
    // Extract log IDs for the notification payload
    const logIds = insertedLogs.map((log) => log.id);
    notificationPublisher.publishLogIngestion(projectId, logIds).catch((err) => {
      console.error('[Ingestion] Failed to publish notification:', err);
    });

    // Record resource usage (#212). Fire-and-forget, never blocks ingestion.
    if (organizationId) {
      recordLogIngestion({
        logs,
        eventCount: insertedLogs.length,
        organizationId,
        projectId,
      });
    }

    return insertedLogs.length;
  }

  /**
   * Store extracted identifiers for logs
   */
  private async storeIdentifiers(
    insertedLogs: any[],
    identifiersByLog: Map<number, IdentifierMatch[]>,
    projectId: string
  ): Promise<void> {
    try {
      // Get project to find organization_id
      const project = await db
        .selectFrom('projects')
        .select(['organization_id'])
        .where('id', '=', projectId)
        .executeTakeFirst();

      if (!project) {
        console.warn(`[Ingestion] Project not found for storing identifiers: ${projectId}`);
        return;
      }

      const logsWithContext = insertedLogs.map((log) => ({
        id: log.id,
        time: log.time,
        projectId: projectId,
        organizationId: project.organization_id,
      }));

      await correlationService.storeIdentifiers(logsWithContext, identifiersByLog);

      const totalIdentifiers = Array.from(identifiersByLog.values()).reduce(
        (sum, ids) => sum + ids.length,
        0
      );
      console.log(`[Ingestion] Stored ${totalIdentifiers} identifiers for ${identifiersByLog.size} logs`);
    } catch (error) {
      console.error('[Ingestion] Error storing identifiers:', error);
      // Don't throw - ingestion should succeed even if identifier storage fails
    }
  }

  /**
   * Trigger Sigma detection job for ingested logs
   */
  private async triggerSigmaDetection(logs: LogInput[], insertedLogs: any[], projectId: string): Promise<void> {
    try {
      // Get project to find organization_id
      const project = await db
        .selectFrom('projects')
        .select(['organization_id'])
        .where('id', '=', projectId)
        .executeTakeFirst();

      if (!project) {
        console.warn(`[Ingestion] Project not found: ${projectId}`);
        return;
      }

      // Convert logs to LogEntry format for detection engine with IDs
      const logEntries: Array<LogEntry & { id: string }> = logs.map((log, index) => ({
        id: insertedLogs[index]?.id || '',
        service: log.service,
        level: log.level,
        message: log.message,
        metadata: log.metadata,
        trace_id: log.trace_id,
        time: log.time,
      }));

      // Queue Sigma detection job
      const detectionQueue = createQueue('sigma-detection');

      await detectionQueue.add('detect-logs', {
        logs: logEntries,
        organizationId: project.organization_id,
        projectId,
      });

      console.log(`[Ingestion] Queued Sigma detection for ${logs.length} logs`);
    } catch (error) {
      console.error('[Ingestion] Error triggering Sigma detection:', error);
      // Don't throw - ingestion should succeed even if detection queueing fails
    }
  }

  /**
   * Trigger Exception parsing job for error/critical logs
   */
  private async triggerExceptionParsing(logs: LogInput[], insertedLogs: any[], projectId: string): Promise<void> {
    try {
      // Filter only error/critical logs
      const errorLogs = logs
        .map((log, index) => ({ log, inserted: insertedLogs[index] }))
        .filter(({ log }) => log.level === 'error' || log.level === 'critical')
        .map(({ log, inserted }) => ({
          id: inserted?.id || '',
          message: log.message,
          level: log.level as 'error' | 'critical',
          service: log.service,
          metadata: log.metadata,
        }));

      if (errorLogs.length === 0) {
        return;
      }

      // Get project to find organization_id
      const project = await db
        .selectFrom('projects')
        .select(['organization_id'])
        .where('id', '=', projectId)
        .executeTakeFirst();

      if (!project) {
        console.warn(`[Ingestion] Project not found for exception parsing: ${projectId}`);
        return;
      }

      // Queue exception parsing job
      const exceptionQueue = createQueue('exception-parsing');

      await exceptionQueue.add('parse-exceptions', {
        logs: errorLogs,
        organizationId: project.organization_id,
        projectId,
      });

      console.log(`[Ingestion] Queued exception parsing for ${errorLogs.length} error/critical logs`);
    } catch (error) {
      console.error('[Ingestion] Error triggering exception parsing:', error);
      // Don't throw - ingestion should succeed even if exception parsing queueing fails
    }
  }

  /**
   * Trigger log pipeline processing for ingested logs
   */
  private async triggerPipelineProcessing(
    logs: LogInput[],
    insertedLogs: any[],
    projectId: string,
    organizationId: string
  ): Promise<void> {
    try {
      const payload = logs.map((log: LogInput, i: number) => ({
        id: insertedLogs[i]?.id ?? '',
        time:
          insertedLogs[i]?.time instanceof Date
            ? insertedLogs[i].time.toISOString()
            : String(insertedLogs[i]?.time ?? new Date().toISOString()),
        message: log.message,
        metadata: (log.metadata as Record<string, unknown> | null | undefined) ?? null,
      }));

      const pipelineQueue = createQueue('log-pipeline');
      await pipelineQueue.add('process-pipeline', { logs: payload, projectId, organizationId });

      console.log(`[Ingestion] Queued pipeline processing for ${logs.length} logs`);
    } catch (error) {
      console.error('[Ingestion] Error queuing pipeline job:', error);
      // Don't throw - ingestion should succeed even if pipeline queueing fails
    }
  }

  /**
   * Get log statistics (reservoir: works with any engine)
   */
  async getStats(projectId: string, from?: Date, to?: Date) {
    const effectiveFrom = from || new Date(0);
    const effectiveTo = to || new Date();

    const topResult = await reservoir.topValues({
      field: 'level',
      projectId,
      from: effectiveFrom,
      to: effectiveTo,
      limit: 20, // enough for all log levels
    });

    const byLevel: Record<string, number> = {};
    let total = 0;
    for (const v of topResult.values) {
      byLevel[v.value] = v.count;
      total += v.count;
    }

    return { total, by_level: byLevel };
  }
}

export const ingestionService = new IngestionService();
