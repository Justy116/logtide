import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../database/index.js';
import { meteringService } from '../../../modules/metering/service.js';
import { createTestContext } from '../../helpers/factories.js';

describe('MeteringService.aggregate', () => {
  let orgA: string;
  let projectA: string;
  let orgB: string;

  async function insert(rows: Array<{
    org: string; project?: string | null; type: string; quantity: number; time: string;
  }>) {
    await db.insertInto('metering_events').values(
      rows.map((r) => ({
        time: new Date(r.time),
        organization_id: r.org,
        project_id: r.project ?? null,
        type: r.type,
        quantity: r.quantity,
        metadata: null,
      }))
    ).execute();
  }

  beforeEach(async () => {
    await db.deleteFrom('metering_events').execute();
    const a = await createTestContext();
    orgA = a.organization.id;
    projectA = a.project.id;
    const b = await createTestContext();
    orgB = b.organization.id;
  });

  it('groups by type and sums quantity', async () => {
    await insert([
      { org: orgA, project: projectA, type: 'logs.ingested.events', quantity: 10, time: '2026-06-01T01:00:00Z' },
      { org: orgA, project: projectA, type: 'logs.ingested.events', quantity: 5, time: '2026-06-01T02:00:00Z' },
      { org: orgA, project: projectA, type: 'logs.ingested.bytes', quantity: 2048, time: '2026-06-01T02:00:00Z' },
    ]);

    const rows = await meteringService.aggregate({
      organizationId: orgA,
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-02T00:00:00Z'),
      groupBy: 'type',
    });

    const byType = Object.fromEntries(rows.map((r) => [r.type, r.quantity]));
    expect(byType['logs.ingested.events']).toBe(15);
    expect(byType['logs.ingested.bytes']).toBe(2048);
  });

  it('isolates organizations (org A never sees org B usage)', async () => {
    await insert([
      { org: orgA, project: projectA, type: 'logs.ingested.events', quantity: 10, time: '2026-06-01T01:00:00Z' },
      { org: orgB, project: null, type: 'logs.ingested.events', quantity: 999, time: '2026-06-01T01:00:00Z' },
    ]);

    const rows = await meteringService.aggregate({
      organizationId: orgA,
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-02T00:00:00Z'),
      groupBy: 'type',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(10);
  });

  it('groups by day buckets', async () => {
    await insert([
      { org: orgA, project: projectA, type: 'logs.ingested.events', quantity: 3, time: '2026-06-01T05:00:00Z' },
      { org: orgA, project: projectA, type: 'logs.ingested.events', quantity: 4, time: '2026-06-01T23:00:00Z' },
      { org: orgA, project: projectA, type: 'logs.ingested.events', quantity: 7, time: '2026-06-02T05:00:00Z' },
    ]);

    const rows = await meteringService.aggregate({
      organizationId: orgA,
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-03T00:00:00Z'),
      groupBy: 'day',
    });

    const byDay = rows.map((r) => ({ day: (r.bucket ?? '').slice(0, 10), q: r.quantity }));
    expect(byDay).toContainEqual({ day: '2026-06-01', q: 7 });
    expect(byDay).toContainEqual({ day: '2026-06-02', q: 7 });
  });

  it('filters by type when provided', async () => {
    await insert([
      { org: orgA, project: projectA, type: 'logs.ingested.events', quantity: 10, time: '2026-06-01T01:00:00Z' },
      { org: orgA, project: projectA, type: 'logs.ingested.bytes', quantity: 2048, time: '2026-06-01T01:00:00Z' },
    ]);

    const rows = await meteringService.aggregate({
      organizationId: orgA,
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-02T00:00:00Z'),
      groupBy: 'type',
      type: 'logs.ingested.bytes',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('logs.ingested.bytes');
    expect(rows[0].quantity).toBe(2048);
  });
});
