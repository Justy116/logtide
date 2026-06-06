import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../database/index.js';
import { configSchema } from '../../../config/index.js';
import { StorageSnapshotJob } from '../../../modules/metering/storage-snapshot.js';
import { meteringRecorder, meteringService } from '../../../modules/metering/index.js';
import { createTestContext, createTestProject } from '../../helpers/factories.js';

async function insertIngestedBytes(orgId: string, projectId: string, quantity: number, time: Date) {
  await db
    .insertInto('metering_events')
    .values({
      time,
      organization_id: orgId,
      project_id: projectId,
      type: 'logs.ingested.bytes',
      quantity,
      metadata: null,
    })
    .execute();
}

async function setRetentionDays(orgId: string, days: number) {
  await db.updateTable('organizations').set({ retention_days: days }).where('id', '=', orgId).execute();
}

async function snapshotRows(orgId: string) {
  return db
    .selectFrom('metering_events')
    .selectAll()
    .where('organization_id', '=', orgId)
    .where('type', '=', 'storage.snapshot')
    .orderBy('project_id')
    .execute();
}

describe('storage snapshot config', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    API_KEY_SECRET: 'x'.repeat(32),
  };

  it('defaults the snapshot job on with a daily interval', () => {
    const cfg = configSchema.parse(base);
    expect(cfg.STORAGE_SNAPSHOT_ENABLED).toBe(true);
    expect(cfg.STORAGE_SNAPSHOT_INTERVAL_MS).toBe(86400000);
  });

  it('parses overrides from env strings', () => {
    const cfg = configSchema.parse({
      ...base,
      STORAGE_SNAPSHOT_ENABLED: 'false',
      STORAGE_SNAPSHOT_INTERVAL_MS: '3600000',
    });
    expect(cfg.STORAGE_SNAPSHOT_ENABLED).toBe(false);
    expect(cfg.STORAGE_SNAPSHOT_INTERVAL_MS).toBe(3600000);
  });
});

describe('StorageSnapshotJob.runOnce', () => {
  let orgId: string;
  let projectA: string;

  beforeEach(async () => {
    await db.deleteFrom('metering_events').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectA = ctx.project.id;
  });

  it('records one snapshot per project with the bytes ingested inside the retention window', async () => {
    await setRetentionDays(orgId, 30);
    const inside = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const outside = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const other = await createTestProject({ organizationId: orgId, name: 'second' });

    await insertIngestedBytes(orgId, projectA, 1000, inside);
    await insertIngestedBytes(orgId, projectA, 500, inside);
    await insertIngestedBytes(orgId, projectA, 99999, outside); // outside retention: excluded
    await insertIngestedBytes(orgId, other.id, 300, inside);

    const job = new StorageSnapshotJob();
    await job.runOnce();
    await meteringRecorder.flush();

    const rows = await snapshotRows(orgId);
    expect(rows).toHaveLength(2);
    const byProject = Object.fromEntries(rows.map((r) => [r.project_id, Number(r.quantity)]));
    expect(byProject[projectA]).toBe(1500);
    expect(byProject[other.id]).toBe(300);
  });

  it('skips organizations with no ingestion history', async () => {
    const job = new StorageSnapshotJob();
    await job.runOnce();
    await meteringRecorder.flush();

    expect(await snapshotRows(orgId)).toHaveLength(0);
  });

  it('isolates organizations', async () => {
    const otherCtx = await createTestContext();
    await setRetentionDays(orgId, 30);
    await insertIngestedBytes(orgId, projectA, 700, new Date());

    const job = new StorageSnapshotJob();
    await job.runOnce();
    await meteringRecorder.flush();

    expect(await snapshotRows(orgId)).toHaveLength(1);
    expect(await snapshotRows(otherCtx.organization.id)).toHaveLength(0);
  });

  it('one org failing does not block others (fail-open per org)', async () => {
    // Insert an ingestion event whose organization row is then deleted:
    // the per-org retention lookup finds nothing and that org is skipped with a warn.
    const doomed = await createTestContext();
    await insertIngestedBytes(doomed.organization.id, doomed.project.id, 100, new Date());
    await db.deleteFrom('organizations').where('id', '=', doomed.organization.id).execute();
    // metering_events has no FK to organizations (migration 045), so the event row survives the org delete.

    await setRetentionDays(orgId, 30);
    await insertIngestedBytes(orgId, projectA, 800, new Date());

    const job = new StorageSnapshotJob();
    await job.runOnce();
    await meteringRecorder.flush();

    const rows = await snapshotRows(orgId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].quantity)).toBe(800);
  });

  it('decays a project to zero when its data ages out of the retention window', async () => {
    await setRetentionDays(orgId, 30);
    await insertIngestedBytes(orgId, projectA, 1000, new Date());

    const job = new StorageSnapshotJob();
    await job.runOnce();
    await meteringRecorder.flush();
    expect((await snapshotRows(orgId)).map((r) => Number(r.quantity))).toEqual([1000]);

    // Simulate the data aging out: remove the bytes events, keep the snapshot.
    await db
      .deleteFrom('metering_events')
      .where('organization_id', '=', orgId)
      .where('type', '=', 'logs.ingested.bytes')
      .execute();

    await job.runOnce();
    await meteringRecorder.flush();

    expect(await meteringService.latestPointInTime(orgId, 'storage.snapshot')).toBe(0);
  });

  it('stops recording zeros once the latest snapshot is already zero', async () => {
    await setRetentionDays(orgId, 30);
    await insertIngestedBytes(orgId, projectA, 500, new Date());

    const job = new StorageSnapshotJob();
    await job.runOnce();
    await meteringRecorder.flush();

    await db
      .deleteFrom('metering_events')
      .where('organization_id', '=', orgId)
      .where('type', '=', 'logs.ingested.bytes')
      .execute();

    await job.runOnce(); // writes the zero
    await meteringRecorder.flush();
    const afterZero = (await snapshotRows(orgId)).length;

    await job.runOnce(); // must NOT write another zero
    await meteringRecorder.flush();
    expect((await snapshotRows(orgId)).length).toBe(afterZero);
  });
});
