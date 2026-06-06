import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { reservoirReady } from '../../../database/reservoir.js';
import { ingestionService } from '../../../modules/ingestion/service.js';
import { queryService } from '../../../modules/query/service.js';
import { hooks, HookRejectionError } from '../../../hooks/index.js';
import type { LogInput } from '@logtide/shared';
import { createTestContext } from '../../helpers/factories.js';

describe('beforeQuery hook', () => {
  let projectId: string;

  beforeAll(async () => {
    await reservoirReady;
  });

  beforeEach(async () => {
    hooks.clear();
    const ctx = await createTestContext();
    projectId = ctx.project.id;

    const logs: LogInput[] = [
      { time: new Date(), service: 'svc-a', level: 'info', message: 'from a' },
      { time: new Date(), service: 'svc-b', level: 'info', message: 'from b' },
    ];
    await ingestionService.ingestLogs(logs, projectId);
  });

  afterEach(() => {
    hooks.clear();
  });

  it('receives the parsed params and query proceeds when the hook passes', async () => {
    let seenProjectIds: string[] = [];
    hooks.register('beforeQuery', async (ctx) => {
      seenProjectIds = ctx.projectIds;
    });

    const result = await queryService.queryLogs({ projectId });
    expect(seenProjectIds).toEqual([projectId]);
    expect(result.logs).toHaveLength(2);
  });

  it('rejection aborts the query', async () => {
    hooks.register('beforeQuery', async () => {
      throw new HookRejectionError('policy.query_denied', 'queries are rate limited', 429);
    });

    await expect(queryService.queryLogs({ projectId })).rejects.toMatchObject({
      code: 'policy.query_denied',
      statusCode: 429,
    });
  });

  it('mutation: a hook can force a service filter and results reflect it', async () => {
    hooks.register('beforeQuery', async (ctx) => {
      ctx.params.service = 'svc-a';
    });

    const result = await queryService.queryLogs({ projectId });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].service).toBe('svc-a');
  });

  it('mutated params drive the cache key (no stale unfiltered hit)', async () => {
    // Prime the cache WITHOUT the hook (unfiltered query, 2 results)
    const unfiltered = await queryService.queryLogs({ projectId });
    expect(unfiltered.logs).toHaveLength(2);

    // Same caller-visible params, but the hook now narrows the query.
    // If the cache key were built before the hook ran, this would return
    // the stale 2-row unfiltered result.
    hooks.register('beforeQuery', async (ctx) => {
      ctx.params.service = 'svc-a';
    });

    const filtered = await queryService.queryLogs({ projectId });
    expect(filtered.logs).toHaveLength(1);
  });
});
