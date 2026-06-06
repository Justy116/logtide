import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../database/index.js';
import { recordSpanIngestion, meteringRecorder } from '../../../modules/metering/index.js';
import { createTestContext } from '../../helpers/factories.js';

describe('recordSpanIngestion', () => {
  let orgId: string;
  let projectId: string;

  beforeEach(async () => {
    await db.deleteFrom('metering_events').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;
  });

  it('records the span count for an ingested batch', async () => {
    recordSpanIngestion({ spanCount: 7, organizationId: orgId, projectId });
    await meteringRecorder.flush();

    const rows = await db
      .selectFrom('metering_events')
      .selectAll()
      .where('organization_id', '=', orgId)
      .where('type', '=', 'spans.ingested')
      .execute();

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].quantity)).toBe(7);
    expect(rows[0].project_id).toBe(projectId);
  });

  it('records nothing for a zero-span batch', async () => {
    recordSpanIngestion({ spanCount: 0, organizationId: orgId, projectId });
    await meteringRecorder.flush();

    const rows = await db
      .selectFrom('metering_events')
      .selectAll()
      .where('organization_id', '=', orgId)
      .where('type', '=', 'spans.ingested')
      .execute();

    expect(rows).toHaveLength(0);
  });
});
