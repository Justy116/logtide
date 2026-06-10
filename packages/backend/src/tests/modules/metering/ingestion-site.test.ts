import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { db } from '../../../database/index.js';
import { reservoirReady } from '../../../database/reservoir.js';
import { ingestionService } from '../../../modules/ingestion/service.js';
import { meteringRecorder } from '../../../modules/metering/index.js';
import type { LogInput } from '@logtide/shared';
import { createTestContext } from '../../helpers/factories.js';

describe('ingestion records usage metering', () => {
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    await reservoirReady;
  });

  beforeEach(async () => {
    await db.deleteFrom('metering_events').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;
  });

  it('writes logs.ingested.events and logs.ingested.bytes after ingest', async () => {
    const logs: LogInput[] = [
      { time: new Date(), service: 'api', level: 'info', message: 'a' },
      { time: new Date(), service: 'api', level: 'info', message: 'b' },
      { time: new Date(), service: 'api', level: 'warn', message: 'c' },
    ];

    const inserted = (await ingestionService.ingestLogs(logs, projectId)).received;
    expect(inserted).toBe(3);

    await meteringRecorder.flush();

    const rows = await db
      .selectFrom('metering_events')
      .selectAll()
      .where('organization_id', '=', orgId)
      .execute();

    const byType = Object.fromEntries(rows.map((r) => [r.type, Number(r.quantity)]));
    expect(byType['logs.ingested.events']).toBe(3);
    expect(byType['logs.ingested.bytes']).toBeGreaterThan(0);
    expect(rows.every((r) => r.project_id === projectId)).toBe(true);
  });
});
