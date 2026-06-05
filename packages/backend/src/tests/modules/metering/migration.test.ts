import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../database/index.js';
import { createTestContext } from '../../helpers/factories.js';

describe('metering_events table', () => {
  let orgId: string;
  let projectId: string;

  beforeEach(async () => {
    await db.deleteFrom('metering_events').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;
  });

  it('accepts a metering event row and reads it back', async () => {
    await db
      .insertInto('metering_events')
      .values({
        time: new Date('2026-06-01T00:00:00Z'),
        organization_id: orgId,
        project_id: projectId,
        type: 'logs.ingested.events',
        quantity: 42,
        metadata: { source: 'test' },
      })
      .execute();

    const rows = await db
      .selectFrom('metering_events')
      .selectAll()
      .where('organization_id', '=', orgId)
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('logs.ingested.events');
    expect(Number(rows[0].quantity)).toBe(42);
    expect(rows[0].project_id).toBe(projectId);
  });

  it('allows a null project_id', async () => {
    await db
      .insertInto('metering_events')
      .values({
        time: new Date('2026-06-01T00:00:00Z'),
        organization_id: orgId,
        project_id: null,
        type: 'storage.snapshot',
        quantity: 1,
        metadata: null,
      })
      .execute();

    const rows = await db
      .selectFrom('metering_events')
      .selectAll()
      .where('organization_id', '=', orgId)
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBeNull();
  });
});
