import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../database/index.js';
import { meteringService } from '../../../modules/metering/index.js';
import { createTestContext, createTestProject } from '../../helpers/factories.js';

async function insertEvent(params: {
  orgId: string;
  projectId: string | null;
  type: string;
  quantity: number;
  time: Date;
}) {
  await db
    .insertInto('metering_events')
    .values({
      time: params.time,
      organization_id: params.orgId,
      project_id: params.projectId,
      type: params.type,
      quantity: params.quantity,
      metadata: null,
    })
    .execute();
}

describe('MeteringService.latestPointInTime', () => {
  let orgId: string;
  let projectA: string;

  beforeEach(async () => {
    await db.deleteFrom('metering_events').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectA = ctx.project.id;
  });

  it('returns 0 when no snapshot exists', async () => {
    expect(await meteringService.latestPointInTime(orgId, 'storage.snapshot')).toBe(0);
  });

  it('returns the LATEST snapshot per project, not the sum of history', async () => {
    const t1 = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const t2 = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await insertEvent({ orgId, projectId: projectA, type: 'storage.snapshot', quantity: 100, time: t1 });
    await insertEvent({ orgId, projectId: projectA, type: 'storage.snapshot', quantity: 250, time: t2 });

    expect(await meteringService.latestPointInTime(orgId, 'storage.snapshot')).toBe(250);
  });

  it('sums the latest snapshot across projects', async () => {
    const other = await createTestProject({ organizationId: orgId, name: 'second' });
    const t = new Date();
    await insertEvent({ orgId, projectId: projectA, type: 'storage.snapshot', quantity: 100, time: t });
    await insertEvent({ orgId, projectId: other.id, type: 'storage.snapshot', quantity: 40, time: t });

    expect(await meteringService.latestPointInTime(orgId, 'storage.snapshot')).toBe(140);
  });

  it('is organization-scoped', async () => {
    const otherCtx = await createTestContext();
    await insertEvent({ orgId: otherCtx.organization.id, projectId: otherCtx.project.id, type: 'storage.snapshot', quantity: 999, time: new Date() });

    expect(await meteringService.latestPointInTime(orgId, 'storage.snapshot')).toBe(0);
  });
});

describe('MeteringService.storageSeries', () => {
  let orgId: string;
  let projectA: string;

  beforeEach(async () => {
    await db.deleteFrom('metering_events').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectA = ctx.project.id;
  });

  it('returns one point per UTC day using the last snapshot of that day, summed across projects', async () => {
    const other = await createTestProject({ organizationId: orgId, name: 'second' });
    const day1early = new Date('2026-06-01T03:00:00Z');
    const day1late = new Date('2026-06-01T20:00:00Z');
    const day2 = new Date('2026-06-02T12:00:00Z');

    // Two snapshots same day for projectA: only the later one (150) counts for day 1.
    await insertEvent({ orgId, projectId: projectA, type: 'storage.snapshot', quantity: 100, time: day1early });
    await insertEvent({ orgId, projectId: projectA, type: 'storage.snapshot', quantity: 150, time: day1late });
    await insertEvent({ orgId, projectId: other.id, type: 'storage.snapshot', quantity: 50, time: day1early });
    await insertEvent({ orgId, projectId: projectA, type: 'storage.snapshot', quantity: 180, time: day2 });

    const series = await meteringService.storageSeries(
      orgId,
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-03T00:00:00Z')
    );

    expect(series).toEqual([
      { bucket: '2026-06-01', quantity: 200 }, // 150 (latest of projectA) + 50 (other)
      { bucket: '2026-06-02', quantity: 180 },
    ]);
  });

  it('returns an empty array when there are no snapshots in range', async () => {
    const series = await meteringService.storageSeries(orgId, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
    expect(series).toEqual([]);
  });
});
