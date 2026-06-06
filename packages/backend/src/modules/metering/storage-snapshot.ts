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

  /** Orgs worth snapshotting: any ingestion history, plus orgs with existing
   *  snapshots (so stale gauges keep decaying after ingestion data ages out). */
  private async activeOrgIds(): Promise<string[]> {
    const rows = await db
      .selectFrom('metering_events')
      .select('organization_id')
      .distinct()
      .where('type', 'in', ['logs.ingested.bytes', 'storage.snapshot'])
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

    // Zero-decay: a project absent from the current window but whose latest
    // snapshot is nonzero must be snapshotted to 0, otherwise the gauge (and
    // the storage.max_bytes block) would stay frozen at the last value forever.
    // Once the latest snapshot is 0 we stop recording, so dead projects do not
    // accumulate endless zero rows.
    const currentProjects = new Set(rows.map((r) => r.project_id));
    const previous = await db
      .selectFrom('metering_events')
      .select(['project_id', 'quantity'])
      .distinctOn('project_id')
      .where('organization_id', '=', organizationId)
      .where('type', '=', 'storage.snapshot')
      .orderBy('project_id')
      .orderBy('time', 'desc')
      .execute();

    for (const prev of previous) {
      if (!prev.project_id || currentProjects.has(prev.project_id)) continue;
      if (Number(prev.quantity) > 0) {
        metering.record({
          type: 'storage.snapshot',
          quantity: 0,
          organizationId,
          projectId: prev.project_id,
        });
      }
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
    if (this.timer || !config.STORAGE_SNAPSHOT_ENABLED || !config.METERING_ENABLED) return;
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
