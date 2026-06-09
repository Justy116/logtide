import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '../../../database/index.js';
import { reservoirReady } from '../../../database/reservoir.js';
import { ingestionService } from '../../../modules/ingestion/service.js';
import { alertsService } from '../../../modules/alerts/service.js';
import { hooks, HookRejectionError } from '../../../hooks/index.js';
import type { LogInput } from '@logtide/shared';
import { createTestContext, createTestAlertRule } from '../../helpers/factories.js';

describe('beforeAlertEvaluation hook', () => {
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

    // One error log so threshold-1 rules trigger
    const logs: LogInput[] = [
      { time: new Date(), service: 'api', level: 'error', message: 'boom' },
    ];
    await ingestionService.ingestLogs(logs, projectId);
  });

  afterEach(() => {
    hooks.clear();
  });

  it('receives org/rule context for each evaluated rule', async () => {
    const rule = await createTestAlertRule({
      organizationId: orgId,
      projectId,
      threshold: 1,
      timeWindow: 60,
      level: ['error'],
    });

    const seen: Array<{ organizationId: string; ruleId: string; ruleType: string }> = [];
    hooks.register('beforeAlertEvaluation', async (ctx) => {
      seen.push({ organizationId: ctx.organizationId, ruleId: ctx.ruleId, ruleType: ctx.ruleType });
    });

    const triggered = await alertsService.checkAlertRules();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ organizationId: orgId, ruleId: rule.id, ruleType: 'threshold' });
    expect(triggered).toHaveLength(1);
  });

  it('rejection skips only that rule; the rest of the batch evaluates', async () => {
    const ruleA = await createTestAlertRule({
      organizationId: orgId,
      projectId,
      name: 'rule-a',
      threshold: 1,
      timeWindow: 60,
      level: ['error'],
    });
    const ruleB = await createTestAlertRule({
      organizationId: orgId,
      projectId,
      name: 'rule-b',
      threshold: 1,
      timeWindow: 60,
      level: ['error'],
    });

    hooks.register('beforeAlertEvaluation', async (ctx) => {
      if (ctx.ruleId === ruleA.id) {
        throw new HookRejectionError('policy.rule_suspended', 'rule suspended by policy');
      }
    });

    const triggered = await alertsService.checkAlertRules();
    expect(triggered).toHaveLength(1);
    expect(triggered[0].rule_id).toBe(ruleB.id);

    // Skipped rule must not have recorded history
    const historyA = await db
      .selectFrom('alert_history')
      .selectAll()
      .where('rule_id', '=', ruleA.id)
      .execute();
    expect(historyA).toHaveLength(0);
  });

  it('an unexpectedly throwing hook also skips the rule without killing the batch', async () => {
    const ruleA = await createTestAlertRule({
      organizationId: orgId,
      projectId,
      name: 'rule-a',
      threshold: 1,
      timeWindow: 60,
      level: ['error'],
    });
    const ruleB = await createTestAlertRule({
      organizationId: orgId,
      projectId,
      name: 'rule-b',
      threshold: 1,
      timeWindow: 60,
      level: ['error'],
    });

    hooks.register('beforeAlertEvaluation', async (ctx) => {
      if (ctx.ruleId === ruleA.id) {
        throw new TypeError('broken hook');
      }
    });

    const triggered = await alertsService.checkAlertRules();
    expect(triggered).toHaveLength(1);
    expect(triggered[0].rule_id).toBe(ruleB.id);
  });

  it('reports ruleType rate_of_change for rate-of-change rules', async () => {
    await createTestAlertRule({
      organizationId: orgId,
      projectId,
      threshold: 1,
      timeWindow: 60,
      level: ['error'],
      alertType: 'rate_of_change',
      baselineType: 'same_time_yesterday',
      deviationMultiplier: 2,
    });

    const seenTypes: string[] = [];
    hooks.register('beforeAlertEvaluation', async (ctx) => {
      seenTypes.push(ctx.ruleType);
    });

    await alertsService.checkAlertRules();
    expect(seenTypes).toEqual(['rate_of_change']);
  });
});
