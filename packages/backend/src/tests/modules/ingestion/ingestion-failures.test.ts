import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted ensures the mock factory runs before any module import
const { addMock, exceptionAddMock, createQueueMock } = vi.hoisted(() => {
  const addMock = vi.fn();
  const exceptionAddMock = vi.fn().mockResolvedValue({});
  const createQueueMock = vi.fn((name: string) => {
    if (name === 'sigma-detection') return { add: addMock };
    if (name === 'exception-parsing') return { add: exceptionAddMock };
    // All other queues succeed silently
    return { add: vi.fn().mockResolvedValue({}) };
  });
  return { addMock, exceptionAddMock, createQueueMock };
});

vi.mock('../../../queue/connection.js', () => ({
  createQueue: createQueueMock,
}));

import { ingestionService } from '../../../modules/ingestion/service.js';
import { metering } from '../../../modules/metering/index.js';
import { correlationService } from '../../../modules/correlation/service.js';
import { createTestContext } from '../../helpers/factories.js';
import { db } from '../../../database/index.js';

describe('ingestion enqueue failure visibility', () => {
  let projectId: string;

  beforeEach(async () => {
    // Full cleanup to match setup.ts cleanup order
    await db.deleteFrom('log_identifiers').execute().catch(() => {});
    await db.deleteFrom('logs').execute().catch(() => {});
    await db.deleteFrom('alert_history').execute().catch(() => {});
    await db.deleteFrom('sigma_rules').execute().catch(() => {});
    await db.deleteFrom('alert_rules').execute().catch(() => {});
    await db.deleteFrom('api_keys').execute().catch(() => {});
    await db.deleteFrom('notifications').execute().catch(() => {});
    await db.deleteFrom('organization_members').execute().catch(() => {});
    await db.deleteFrom('projects').execute().catch(() => {});
    await db.deleteFrom('organizations').execute().catch(() => {});
    await db.deleteFrom('sessions').execute().catch(() => {});
    await db.deleteFrom('users').execute().catch(() => {});

    const ctx = await createTestContext();
    projectId = ctx.project.id;

    addMock.mockReset();
    exceptionAddMock.mockReset();
    exceptionAddMock.mockResolvedValue({});
    createQueueMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries the sigma enqueue once and records a counter when both attempts fail', async () => {
    addMock.mockRejectedValue(new Error('redis down'));
    const recordSpy = vi.spyOn(metering, 'record').mockImplementation(() => {});

    const result = await ingestionService.ingestLogs(
      [{ time: new Date(), service: 'svc', level: 'info', message: 'hello' }],
      projectId
    );

    // Ingestion itself still succeeds
    expect(result.received).toBe(1);

    // Wait for the fire-and-forget detection trigger to settle
    await new Promise((r) => setTimeout(r, 100));

    // sigma-detection add called twice: first attempt + one retry
    expect(addMock).toHaveBeenCalledTimes(2);
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ingestion.detection_enqueue_failed', quantity: 1 })
    );
  });

  it('does not record a counter when the retry succeeds', async () => {
    addMock.mockRejectedValueOnce(new Error('blip')).mockResolvedValue({} as any);
    const recordSpy = vi.spyOn(metering, 'record').mockImplementation(() => {});

    const result = await ingestionService.ingestLogs(
      [{ time: new Date(), service: 'svc', level: 'info', message: 'hello' }],
      projectId
    );
    expect(result.received).toBe(1);
    await new Promise((r) => setTimeout(r, 100));

    // sigma-detection add called twice: first attempt failed, retry succeeded
    expect(addMock).toHaveBeenCalledTimes(2);
    expect(recordSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ingestion.detection_enqueue_failed' })
    );
  });

  it('retries the exception enqueue once and records a counter when both attempts fail', async () => {
    // sigma queue succeeds (undefined resolve), exception queue fails twice
    addMock.mockResolvedValue({} as any);
    exceptionAddMock.mockRejectedValue(new Error('redis down'));
    const recordSpy = vi.spyOn(metering, 'record').mockImplementation(() => {});

    const result = await ingestionService.ingestLogs(
      [{ time: new Date(), service: 'svc', level: 'error', message: 'boom' }],
      projectId
    );

    expect(result.received).toBe(1);
    await new Promise((r) => setTimeout(r, 100));

    // exception-parsing add called twice: first attempt + one retry
    expect(exceptionAddMock).toHaveBeenCalledTimes(2);
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ingestion.exception_enqueue_failed', quantity: 1 })
    );
  });

  it('records identifier_failed when identifier extraction throws', async () => {
    addMock.mockResolvedValue({} as any);
    vi.spyOn(correlationService, 'extractIdentifiersAsync').mockRejectedValue(
      new Error('pattern compile error')
    );
    const recordSpy = vi.spyOn(metering, 'record').mockImplementation(() => {});

    const result = await ingestionService.ingestLogs(
      [{ time: new Date(), service: 'svc', level: 'info', message: 'hello' }],
      projectId
    );

    // Extraction failure is enrichment-only; ingestion still succeeds
    expect(result.received).toBe(1);
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ingestion.identifier_failed', quantity: 1 })
    );
  });
});
