import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '../../../database/index.js';
import { reservoirReady } from '../../../database/reservoir.js';
import { ingestionService } from '../../../modules/ingestion/service.js';
import { alertsService } from '../../../modules/alerts/service.js';
import { hooks } from '../../../hooks/index.js';
import type { AfterAlertTriggeredContext } from '../../../hooks/index.js';
import type { LogInput } from '@logtide/shared';
import { createTestContext, createTestAlertRule } from '../../helpers/factories.js';

describe('afterAlertTriggered hook (threshold path)', () => {
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    await reservoirReady;
  });

  beforeEach(async () => {
    hooks.clear();
    await db.deleteFrom('alert_history').execute();
    await db.deleteFrom('alert_rules').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;

    // One error log so threshold-1 rules fire
    const logs: LogInput[] = [
      { time: new Date(), service: 'api', level: 'error', message: 'boom' },
    ];
    await ingestionService.ingestLogs(logs, projectId);
  });

  afterEach(() => {
    hooks.clear();
    vi.restoreAllMocks();
  });

  it('fires afterAlertTriggered with non-empty historyId and ruleId on the threshold path', async () => {
    const rule = await createTestAlertRule({
      organizationId: orgId,
      projectId,
      threshold: 1,
      timeWindow: 60,
      level: ['error'],
    });

    let captured: AfterAlertTriggeredContext | null = null;
    hooks.register('afterAlertTriggered', async (ctx) => {
      captured = { ...ctx };
    });

    const triggered = await alertsService.checkAlertRules();
    expect(triggered).toHaveLength(1);

    // fire-and-forget: give a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(captured).not.toBeNull();
    expect(captured!.ruleId).toBe(rule.id);
    expect(captured!.historyId).toBeTruthy();
    expect(captured!.historyId.length).toBeGreaterThan(0);
    expect(captured!.ruleName).toBeTruthy();
    expect(captured!.logCount).toBeGreaterThanOrEqual(1);
    expect(captured!.organizationId).toBe(orgId);
    expect(captured!.projectId).toBe(projectId);
    expect(captured!.baselineMetadata).toBeNull();
  });

  it('context is frozen', async () => {
    await createTestAlertRule({
      organizationId: orgId,
      projectId,
      threshold: 1,
      timeWindow: 60,
      level: ['error'],
    });

    let received: AfterAlertTriggeredContext | null = null;
    hooks.register('afterAlertTriggered', async (ctx) => {
      received = ctx;
    });

    await alertsService.checkAlertRules();
    await new Promise((r) => setTimeout(r, 10));

    expect(Object.isFrozen(received)).toBe(true);
  });

  it('a throwing afterAlertTriggered handler does not affect the trigger result', async () => {
    await createTestAlertRule({
      organizationId: orgId,
      projectId,
      threshold: 1,
      timeWindow: 60,
      level: ['error'],
    });

    hooks.register('afterAlertTriggered', async () => {
      throw new Error('handler crash');
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const triggered = await alertsService.checkAlertRules();

    await new Promise((r) => setTimeout(r, 10));

    expect(triggered).toHaveLength(1);
    warn.mockRestore();
  });

  it('hook is NOT fired when threshold is not reached', async () => {
    await createTestAlertRule({
      organizationId: orgId,
      projectId,
      threshold: 100, // never triggered
      timeWindow: 60,
      level: ['error'],
    });

    let fired = false;
    hooks.register('afterAlertTriggered', async () => { fired = true; });

    const triggered = await alertsService.checkAlertRules();
    await new Promise((r) => setTimeout(r, 10));

    expect(triggered).toHaveLength(0);
    expect(fired).toBe(false);
  });
});
