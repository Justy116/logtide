import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { db } from '../../../database/index.js';
import { reservoirReady } from '../../../database/reservoir.js';
import { context } from '@logtide/shared/context';
import { ingestionService } from '../../../modules/ingestion/service.js';
import { quotaFlagCache } from '../../../capabilities/index.js';
import { capabilities } from '../../../capabilities/index.js';
import { QuotaExceededError } from '../../../capabilities/index.js';
import type { LogInput } from '@logtide/shared';
import { createTestContext } from '../../helpers/factories.js';
import Fastify from 'fastify';
import otlpTraceRoutes from '../../../modules/otlp/trace-routes.js';
import otlpRoutes from '../../../modules/otlp/routes.js';

function asOrg<T>(orgId: string, fn: () => Promise<T> | T): Promise<T> {
  return context.run(
    {
      requestId: 'test',
      origin: 'http',
      actor: { type: 'apiKey', id: 'k' },
      organizationId: orgId,
      projectId: null,
    },
    fn
  );
}

describe('ingestion hard-block on usage quota', () => {
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    await reservoirReady;
  });

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    quotaFlagCache.clear();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;
    capabilities.invalidate(orgId);
  });

  const logs: LogInput[] = [
    { time: new Date(), service: 'api', level: 'info', message: 'a' },
    { time: new Date(), service: 'api', level: 'info', message: 'b' },
  ];

  it('ingests normally when no quota is set (default unlimited)', async () => {
    const n = (await asOrg(orgId, () => ingestionService.ingestLogs(logs, projectId))).received;
    expect(n).toBe(2);
  });

  it('rejects with QuotaExceededError (429) when flagged over an ingestion quota', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'ingestion.max_events_monthly', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);
    quotaFlagCache.setOrgFlags(orgId, { 'ingestion.max_events_monthly': true });

    await asOrg(orgId, async () => {
      try {
        await ingestionService.ingestLogs(logs, projectId);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(QuotaExceededError);
        expect((e as QuotaExceededError).statusCode).toBe(429);
        expect((e as QuotaExceededError).code).toBe('capability.ingestion.max_events_monthly.exceeded');
      }
    });

    // Nothing was inserted (check ran before reservoir insert)
    const rows = await db.selectFrom('logs').selectAll().where('project_id', '=', projectId).execute();
    expect(rows).toHaveLength(0);
  });

  it('does not block when no org is in context (fail-open developer guard)', async () => {
    // Without an org context, the helper would throw a developer error; ingestion
    // guards this by only asserting when organizationId is present (see wiring).
    const n = (await ingestionService.ingestLogs(logs, projectId)).received;
    expect(n).toBe(2);
  });
});

describe('span ingestion hard-block on tracing quota', () => {
  let app: any;
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    await reservoirReady;
  });

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    quotaFlagCache.clear();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;
    capabilities.invalidate(orgId);

    app = Fastify();
    // Stand in for the OTLP auth that sets request.projectId.
    app.addHook('onRequest', async (request: any) => {
      request.projectId = projectId;
    });
    await app.register(otlpTraceRoutes);
    await app.ready();
  });

  function otlpTracesBody() {
    const now = Date.now() * 1_000_000; // ns
    return {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: '00000000000000000000000000000001',
                  spanId: '0000000000000001',
                  name: 'op',
                  kind: 1,
                  startTimeUnixNano: String(now),
                  endTimeUnixNano: String(now + 1_000_000),
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it('returns 429 when flagged over tracing.max_spans_monthly', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'tracing.max_spans_monthly', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);
    quotaFlagCache.setOrgFlags(orgId, { 'tracing.max_spans_monthly': true });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/otlp/traces',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(otlpTracesBody()),
    });

    expect(res.statusCode).toBe(429);
  });

  it('ingests spans when no tracing quota is set', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/otlp/traces',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(otlpTracesBody()),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('otlp log ingestion returns 429 on quota', () => {
  let app: any;
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    await reservoirReady;
  });

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    quotaFlagCache.clear();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    projectId = ctx.project.id;
    capabilities.invalidate(orgId);

    app = Fastify();
    // Stand in for the OTLP auth that sets request.projectId.
    app.addHook('onRequest', async (request: any) => {
      request.projectId = projectId;
    });
    await app.register(otlpRoutes);
    await app.ready();
  });

  function otlpLogsBody() {
    const now = String(Date.now() * 1_000_000); // ns
    return {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: now,
                  severityNumber: 9, // INFO
                  body: { stringValue: 'hello from test' },
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it('returns 429 when flagged over ingestion.max_events_monthly', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'ingestion.max_events_monthly', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);
    quotaFlagCache.setOrgFlags(orgId, { 'ingestion.max_events_monthly': true });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/otlp/logs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(otlpLogsBody()),
    });

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.payload);
    expect(body.partialSuccess.rejectedLogRecords).toBe(-1);
  });

  it('ingests logs when no quota is set', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/otlp/logs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(otlpLogsBody()),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.partialSuccess.rejectedLogRecords).toBe(0);
  });
});
