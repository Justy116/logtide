import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../database/index.js';
import { reservoirReady } from '../../../database/reservoir.js';
import { ingestionService } from '../../../modules/ingestion/service.js';
import { hooks, HookRejectionError } from '../../../hooks/index.js';
import type { BeforeIngestContext } from '../../../hooks/index.js';
// HookExecutionError used indirectly via toMatchObject shape assertion
import type { LogInput } from '@logtide/shared';
import { createTestContext } from '../../helpers/factories.js';

describe('beforeIngest hook', () => {
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    await reservoirReady;
  });

  beforeEach(async () => {
    hooks.clear();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;
  });

  afterEach(() => {
    hooks.clear();
  });

  const logs: LogInput[] = [
    { time: new Date(), service: 'api', level: 'info', message: 'keep' },
    { time: new Date(), service: 'api', level: 'info', message: 'drop-me' },
  ];

  it('receives full context and ingestion proceeds when the hook passes', async () => {
    let seen: BeforeIngestContext | null = null;
    hooks.register('beforeIngest', async (ctx) => {
      seen = { ...ctx, records: [...ctx.records] };
    });

    const n = await ingestionService.ingestLogs(logs, projectId);
    expect(n).toBe(2);
    expect(seen).not.toBeNull();
    expect(seen!.projectId).toBe(projectId);
    expect(seen!.organizationId).toBe(orgId);
    expect(seen!.eventCount).toBe(2);
    expect(seen!.byteSize).toBeGreaterThan(0);
    expect(seen!.records).toHaveLength(2);
  });

  it('rejection aborts ingestion before the reservoir write', async () => {
    hooks.register('beforeIngest', async () => {
      throw new HookRejectionError('policy.test_block', 'blocked by test policy', 429);
    });

    await expect(ingestionService.ingestLogs(logs, projectId)).rejects.toMatchObject({
      code: 'policy.test_block',
      statusCode: 429,
    });

    const rows = await db.selectFrom('logs').selectAll().where('project_id', '=', projectId).execute();
    expect(rows).toHaveLength(0);
  });

  it('mutation: a hook can filter records before the write', async () => {
    hooks.register('beforeIngest', async (ctx) => {
      ctx.records = ctx.records.filter((r) => r.message !== 'drop-me');
    });

    const n = await ingestionService.ingestLogs(logs, projectId);
    expect(n).toBe(1);

    const rows = await db.selectFrom('logs').selectAll().where('project_id', '=', projectId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('keep');
  });

  it('a hook that empties the batch results in 0 ingested, nothing written', async () => {
    hooks.register('beforeIngest', async (ctx) => {
      ctx.records = [];
    });

    const n = await ingestionService.ingestLogs(logs, projectId);
    expect(n).toBe(0);

    const rows = await db.selectFrom('logs').selectAll().where('project_id', '=', projectId).execute();
    expect(rows).toHaveLength(0);
  });

  it('unexpected hook errors fail closed (500-class), nothing written', async () => {
    hooks.register('beforeIngest', async () => {
      throw new TypeError('broken hook');
    });

    await expect(ingestionService.ingestLogs(logs, projectId)).rejects.toMatchObject({
      code: 'hook.execution_failed',
      statusCode: 500,
    });

    const rows = await db.selectFrom('logs').selectAll().where('project_id', '=', projectId).execute();
    expect(rows).toHaveLength(0);
  });

  it('mutation: a hook can redact a record field in place', async () => {
    hooks.register('beforeIngest', async (ctx) => {
      const target = ctx.records.find((r) => r.message === 'drop-me');
      if (target) target.message = '[REDACTED]';
    });

    const n = await ingestionService.ingestLogs(logs, projectId);
    expect(n).toBe(2);

    const rows = await db.selectFrom('logs').selectAll().where('project_id', '=', projectId).execute();
    const messages = rows.map((r) => r.message).sort();
    expect(messages).toEqual(['[REDACTED]', 'keep']);
  });

  it('a hook that rewrites projectId fails closed, nothing written', async () => {
    hooks.register('beforeIngest', async (ctx) => {
      ctx.records[0].projectId = '00000000-0000-0000-0000-00000000dead';
    });

    await expect(ingestionService.ingestLogs(logs, projectId)).rejects.toMatchObject({
      code: 'hook.execution_failed',
      statusCode: 500,
    });

    const rows = await db.selectFrom('logs').selectAll().where('project_id', '=', projectId).execute();
    expect(rows).toHaveLength(0);
  });

  it('filtering realigns the logs passed to downstream consumers', async () => {
    const spy = vi.spyOn(ingestionService as any, 'triggerSigmaDetection').mockResolvedValue(undefined);
    try {
      hooks.register('beforeIngest', async (ctx) => {
        ctx.records = ctx.records.filter((r) => r.message !== 'drop-me');
      });

      await ingestionService.ingestLogs(logs, projectId);

      expect(spy).toHaveBeenCalledTimes(1);
      const [logsArg, insertedArg] = spy.mock.calls[0] as [Array<{ message: string }>, Array<unknown>];
      expect(logsArg).toHaveLength(1);
      expect(logsArg[0].message).toBe('keep');
      expect(insertedArg).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
