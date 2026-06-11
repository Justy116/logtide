import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { reservoirReady } from '../../../database/reservoir.js';
import { ingestionService } from '../../../modules/ingestion/service.js';
import { hooks } from '../../../hooks/index.js';
import type { AfterIngestContext } from '../../../hooks/index.js';
import type { LogInput } from '@logtide/shared';
import { createTestContext } from '../../helpers/factories.js';
import { piiMaskingService } from '../../../modules/pii-masking/service.js';

describe('afterIngest hook (integration)', () => {
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
    vi.restoreAllMocks();
  });

  it('fires afterIngest with correct counts when all logs are accepted', async () => {
    const logs: LogInput[] = [
      { time: new Date(), service: 'api', level: 'info', message: 'one' },
      { time: new Date(), service: 'api', level: 'info', message: 'two' },
    ];

    let captured: AfterIngestContext | null = null;
    hooks.register('afterIngest', async (ctx) => {
      captured = { ...ctx };
    });

    const result = await ingestionService.ingestLogs(logs, projectId);
    expect(result.received).toBe(2);

    // give fire-and-forget a tick to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(captured).not.toBeNull();
    expect(captured!.organizationId).toBe(orgId);
    expect(captured!.projectId).toBe(projectId);
    expect(captured!.acceptedCount).toBe(2);
    expect(captured!.rejectedCount).toBe(0);
    expect(captured!.rejectionReasons).toEqual([]);
  });

  it('fires afterIngest with correct counts on a batch with one PII rejection', async () => {
    // Spy maskLogBatch to reject index 0 (simulate PII failure)
    vi.spyOn(piiMaskingService, 'maskLogBatch').mockResolvedValue([0]);

    const logs: LogInput[] = [
      { time: new Date(), service: 'api', level: 'info', message: 'pii-log' },
      { time: new Date(), service: 'api', level: 'info', message: 'clean-log' },
    ];

    let captured: AfterIngestContext | null = null;
    hooks.register('afterIngest', async (ctx) => {
      captured = { ...ctx };
    });

    const result = await ingestionService.ingestLogs(logs, projectId);
    expect(result.received).toBe(1);
    expect(result.rejected).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 10));

    expect(captured).not.toBeNull();
    expect(captured!.acceptedCount).toBe(1);
    expect(captured!.rejectedCount).toBe(1);
    expect(captured!.rejectionReasons).toEqual(['pii_masking_failed']);
    expect(captured!.organizationId).toBe(orgId);
    expect(captured!.projectId).toBe(projectId);
  });

  it('fires afterIngest (acceptedCount 0) on all-rejected path', async () => {
    // Spy maskLogBatch to reject all
    vi.spyOn(piiMaskingService, 'maskLogBatch').mockResolvedValue([0]);

    const logs: LogInput[] = [
      { time: new Date(), service: 'api', level: 'info', message: 'pii-only' },
    ];

    let captured: AfterIngestContext | null = null;
    hooks.register('afterIngest', async (ctx) => {
      captured = { ...ctx };
    });

    const result = await ingestionService.ingestLogs(logs, projectId);
    expect(result.received).toBe(0);

    await new Promise((r) => setTimeout(r, 10));

    expect(captured).not.toBeNull();
    expect(captured!.acceptedCount).toBe(0);
    expect(captured!.rejectedCount).toBe(1);
    expect(captured!.rejectionReasons).toEqual(['pii_masking_failed']);
  });

  it('a throwing afterIngest handler does not affect the ingest result', async () => {
    const logs: LogInput[] = [
      { time: new Date(), service: 'api', level: 'info', message: 'ok' },
    ];

    hooks.register('afterIngest', async () => {
      throw new Error('handler crash');
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await ingestionService.ingestLogs(logs, projectId);

    await new Promise((r) => setTimeout(r, 10));

    expect(result.received).toBe(1);
    expect(result.rejected).toHaveLength(0);
    warn.mockRestore();
  });

  it('hook is NOT fired on the empty-input early return', async () => {
    let fired = false;
    hooks.register('afterIngest', async () => { fired = true; });

    // beforeIngest hook empties records -> triggers the empty-input return (received: 0, rejected: [])
    // We simulate this by passing an empty array directly
    const result = await ingestionService.ingestLogs([], projectId);

    await new Promise((r) => setTimeout(r, 10));

    // empty-input should not fire afterIngest (no rejected, no accepted)
    expect(result.received).toBe(0);
    expect(fired).toBe(false);
  });

  it('fires afterIngest (acceptedCount 0) when beforeIngest filters all records', async () => {
    const logs: LogInput[] = [
      { time: new Date(), service: 'api', level: 'info', message: 'filter-me' },
      { time: new Date(), service: 'api', level: 'info', message: 'filter-me-too' },
    ];

    hooks.register('beforeIngest', async (ctx) => {
      ctx.records = [];
    });

    let captured: AfterIngestContext | null = null;
    hooks.register('afterIngest', async (ctx) => {
      captured = { ...ctx };
    });

    const result = await ingestionService.ingestLogs(logs, projectId);

    await new Promise((r) => setTimeout(r, 10));

    expect(result.received).toBe(0);
    expect(captured).not.toBeNull();
    expect(captured!.acceptedCount).toBe(0);
    expect(captured!.rejectedCount).toBe(0);
    expect(captured!.rejectionReasons).toEqual([]);
    expect(captured!.projectId).toBe(projectId);
    expect(captured!.organizationId).toBe(orgId);
  });
});
