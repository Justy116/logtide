import type { IJob } from '../abstractions/types.js';
import { sql } from 'kysely';
import { db } from '../../database/connection.js';
import { pipelineService } from '../../modules/log-pipeline/service.js';
import { PipelineExecutor } from '../../modules/log-pipeline/pipeline-executor.js';

export interface LogPipelineJobData {
  logs: Array<{
    id: string;
    time: string; // ISO string (serialized for BullMQ)
    message: string;
    metadata: Record<string, unknown> | null;
  }>;
  projectId: string;
  organizationId: string;
}

export async function processLogPipeline(job: IJob<LogPipelineJobData>): Promise<void> {
  const { logs, projectId, organizationId } = job.data;

  const pipeline = await pipelineService.getForProject(projectId, organizationId);
  if (!pipeline || !pipeline.enabled || pipeline.steps.length === 0) return;

  console.log(`[Pipeline] Processing ${logs.length} logs for project ${projectId}`);

  const updates: Array<{ id: string; time: Date; fields: Record<string, unknown> }> = [];

  for (const log of logs) {
    try {
      const result = await PipelineExecutor.execute(
        { id: log.id, time: new Date(log.time), message: log.message, metadata: log.metadata },
        pipeline.steps
      );
      if (Object.keys(result.merged).length > 0) {
        updates.push({ id: log.id, time: new Date(log.time), fields: result.merged });
      }
    } catch (err) {
      console.error(`[Pipeline] Failed to process log ${log.id}:`, err);
    }
  }

  if (updates.length === 0) return;

  // Batch update: pipeline-extracted fields overwrite existing metadata keys
  // of the same name (right-biased `||` in jsonb). We intentionally omit a
  // `time` filter here — JS Date loses microsecond precision vs TimescaleDB's
  // TIMESTAMPTZ, so an exact-match WHERE on time would miss rows.
  for (const update of updates) {
    try {
      await db
        .updateTable('logs')
        .set({
          metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(update.fields)}::jsonb`,
        })
        .where('id', '=', update.id)
        // Defense in depth: scope the tenant-table update to the job's project.
        .where('project_id', '=', projectId)
        .execute();
    } catch (err) {
      console.error(`[Pipeline] Failed to update metadata for log ${update.id}:`, err);
    }
  }

  console.log(`[Pipeline] Updated metadata for ${updates.length}/${logs.length} logs`);
}
