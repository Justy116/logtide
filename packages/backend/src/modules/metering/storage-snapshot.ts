import { db } from '../../database/index.js';
import { config } from '../../config/index.js';
import { context } from '@logtide/shared/context';
import { metering } from './index.js';
import { meteringService } from './service.js';

/**
 * Periodic job (#212 follow-up): estimates per-project stored bytes and records
 * a persisted `storage.snapshot` metering event per (org, project).
 *
 * The estimate is *logical bytes ingested within the org's retention window*
 * (SUM of logs.ingested.bytes over [now - retention_days, now), read from
 * metering_events). It deliberately never queries the reservoir: identical
 * behavior on every storage engine, no full-table scans. It ignores
 * compression and manual deletions by design (gauge of logical data volume).
 *
 * Consumers: the capability quota evaluator (storage.max_bytes, reads the
 * latest snapshot) and the Usage page (daily trend, persisted history).
 */
export class StorageSnapshotJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Orgs worth snapshotting: those with any ingestion history. */
  private async activeOrgIds(): Promise<string[]> {
    const rows = await db
      .selectFrom('metering_events')
      .select('organization_id')
      .distinct()
      .where('type', '=', 'logs.ingested.bytes')
      .execute();
    return rows.map((r) => r.organization_id);
  }

  private async snapshotOrg(organizationId: string, now: Date): Promise<void> {
    const org = await db
      .selectFrom('organizations')
      .select(['retention_days'])
      .where('id', '=', organizationId)
      .executeTakeFirst();
    if (!org) {
      console.warn(`[StorageSnapshot] org ${organizationId} not found, skipping`);
      return;
    }

    const from = new Date(now.getTime() - org.retention_days * 24 * 60 * 60 * 1000);
    const rows = await meteringService.aggregate({
      organizationId,
      from,
      to: now,
      groupBy: 'project',
      type: 'logs.ingested.bytes',
    });

    for (const row of rows) {
      if (!row.project_id) continue;
      metering.record({
        type: 'storage.snapshot',
        quantity: row.quantity,
        organizationId,
        projectId: row.project_id,
      });
    }
  }

  /** One full pass. Exposed for tests and for the interval tick. */
  async runOnce(): Promise<void> {
    const now = new Date();
    const orgIds = await this.activeOrgIds();
    for (const orgId of orgIds) {
      try {
        await this.snapshotOrg(orgId, now);
      } catch (err) {
        // Fail-open per org: one org's failure never blocks the others.
        console.warn(`[StorageSnapshot] snapshot failed for org ${orgId}:`, err);
      }
    }
  }

  start(): void {
    if (this.timer || !config.STORAGE_SNAPSHOT_ENABLED) return;
    const tick = () => {
      void context.runAsSystem('cron:storage-snapshot', async () => {
        if (this.running) return; // in-flight lock
        this.running = true;
        try {
          await this.runOnce();
        } catch (err) {
          console.error('[StorageSnapshot] tick failed:', err);
        } finally {
          this.running = false;
        }
      });
    };
    this.timer = setInterval(tick, config.STORAGE_SNAPSHOT_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    tick(); // run immediately on start
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const storageSnapshotJob = new StorageSnapshotJob();
