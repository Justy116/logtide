import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../database/index.js';
import { recordLogIngestion, meteringRecorder } from '../../../modules/metering/index.js';
import type { LogInput } from '@logtide/shared';
import { createTestContext } from '../../helpers/factories.js';

describe('recordLogIngestion', () => {
  let orgId: string;
  let projectId: string;

  beforeEach(async () => {
    await db.deleteFrom('metering_events').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;
  });

  it('records bytes and events for an ingested batch', async () => {
    const logs: LogInput[] = [
      { time: new Date(), service: 'api', level: 'info', message: 'hello' },
      { time: new Date(), service: 'api', level: 'error', message: 'boom' },
    ];

    recordLogIngestion({ logs, eventCount: logs.length, organizationId: orgId, projectId });
    await meteringRecorder.flush();

    const rows = await db
      .selectFrom('metering_events')
      .selectAll()
      .where('organization_id', '=', orgId)
      .orderBy('type')
      .execute();

    expect(rows).toHaveLength(2);
    const byType = Object.fromEntries(rows.map((r) => [r.type, Number(r.quantity)]));
    expect(byType['logs.ingested.events']).toBe(2);
    expect(byType['logs.ingested.bytes']).toBe(Buffer.byteLength(JSON.stringify(logs)));
    expect(rows.every((r) => r.project_id === projectId)).toBe(true);
  });
});
