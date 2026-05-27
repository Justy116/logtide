import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import { build } from '../../server.js';
import { truncateAllTables, createTestAlertRule, createTestSigmaRule } from '../helpers/index.js';
import { createTestSession } from '../helpers/auth.js';
import { createIsolatedTenants } from './helpers.js';
import { db } from '../../database/index.js';

// Helper: session bearer header for a user
async function sessionHeader(userId: string) {
  const session = await createTestSession(userId);
  return { Authorization: `Bearer ${session.token}` };
}

describe('Tenant isolation - CRUD resources by id', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  // ---------------------------------------------------------------------------
  // Alert rules
  // ---------------------------------------------------------------------------
  describe('alert rules (/api/v1/alerts/:id)', () => {
    it('org B cannot GET org A alert rule', async () => {
      const t = await createIsolatedTenants();
      const ruleA = await createTestAlertRule({ organizationId: t.orgA.id });
      const headers = await sessionHeader(t.orgB.ownerUserId);

      const res = await request(app.server)
        .get(`/api/v1/alerts/${ruleA.id}`)
        .query({ organizationId: t.orgB.id })
        .set(headers);

      // 403 because B user is not a member of orgA; the route also filters by org
      expect([403, 404]).toContain(res.status);
    });

    it('org B cannot PUT (update) org A alert rule', async () => {
      const t = await createIsolatedTenants();
      const ruleA = await createTestAlertRule({ organizationId: t.orgA.id });
      const headers = await sessionHeader(t.orgB.ownerUserId);

      const res = await request(app.server)
        .put(`/api/v1/alerts/${ruleA.id}`)
        .query({ organizationId: t.orgB.id })
        .set(headers)
        .send({ name: 'hacked', emailRecipients: ['x@x.com'] });

      expect([400, 403, 404]).toContain(res.status);

      // verify original row is unchanged
      const row = await db
        .selectFrom('alert_rules')
        .select('name')
        .where('id', '=', ruleA.id)
        .executeTakeFirst();
      expect(row?.name).toBe(ruleA.name);
    });

    it('org B cannot DELETE org A alert rule', async () => {
      const t = await createIsolatedTenants();
      const ruleA = await createTestAlertRule({ organizationId: t.orgA.id });
      const headers = await sessionHeader(t.orgB.ownerUserId);

      const res = await request(app.server)
        .delete(`/api/v1/alerts/${ruleA.id}`)
        .query({ organizationId: t.orgB.id })
        .set(headers);

      expect([403, 404]).toContain(res.status);

      // row must still exist
      const row = await db
        .selectFrom('alert_rules')
        .select('id')
        .where('id', '=', ruleA.id)
        .executeTakeFirst();
      expect(row).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Sigma rules
  // ---------------------------------------------------------------------------
  describe('sigma rules (/api/v1/sigma/rules/:id)', () => {
    it('org B cannot GET org A sigma rule', async () => {
      const t = await createIsolatedTenants();
      const ruleA = await createTestSigmaRule({ organizationId: t.orgA.id });
      const headers = await sessionHeader(t.orgB.ownerUserId);

      const res = await request(app.server)
        .get(`/api/v1/sigma/rules/${ruleA.id}`)
        .query({ organizationId: t.orgB.id })
        .set(headers);

      expect([403, 404]).toContain(res.status);
    });

    it('org B PATCH on org A sigma rule is rejected', async () => {
      const t = await createIsolatedTenants();
      const ruleA = await createTestSigmaRule({ organizationId: t.orgA.id, enabled: true });
      const headers = await sessionHeader(t.orgB.ownerUserId);

      const res = await request(app.server)
        .patch(`/api/v1/sigma/rules/${ruleA.id}`)
        .set(headers)
        .send({ organizationId: t.orgB.id, enabled: false });

      expect([403, 404]).toContain(res.status);

      // original enabled state must be unchanged
      const row = await db
        .selectFrom('sigma_rules')
        .select('enabled')
        .where('id', '=', ruleA.id)
        .executeTakeFirst();
      expect(row?.enabled).toBe(true);
    });

    it('org B DELETE on org A sigma rule id does NOT delete org A data', async () => {
      const t = await createIsolatedTenants();
      const ruleA = await createTestSigmaRule({ organizationId: t.orgA.id });
      const headers = await sessionHeader(t.orgB.ownerUserId);

      // Service scopes lookup to organizationId=orgB.id, finds nothing, throws 500.
      // 404 would be more correct, but either way org A's rule must remain.
      await request(app.server)
        .delete(`/api/v1/sigma/rules/${ruleA.id}`)
        .query({ organizationId: t.orgB.id })
        .set(headers);

      // Critical: org A's sigma rule must still exist
      const row = await db
        .selectFrom('sigma_rules')
        .select('id')
        .where('id', '=', ruleA.id)
        .executeTakeFirst();
      expect(row).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Custom dashboards
  //
  // KNOWN BEHAVIOUR (not a data leak):
  //   PUT  /:id?organizationId=<orgB> - when the row is not found the service
  //        throws NoResultError which maps to 500. No org A data is modified.
  //   DELETE /:id?organizationId=<orgB> - the service silently no-ops when the
  //        row is not found under orgB, and the route returns 204. Org A's
  //        dashboard is NOT actually deleted (verified in DB below).
  //   GET  /:id?organizationId=<orgB> - returns 404 (correct: not found in orgB).
  //
  // The routes correctly scope writes/reads by organizationId; the concern is
  // that DELETE returns 204 (opaque success) instead of 404 when nothing
  // matches. Not a data isolation bug but a noisy HTTP semantics issue.
  // ---------------------------------------------------------------------------
  describe('custom dashboards (/api/v1/custom-dashboards/:id)', () => {
    async function createDashboard(appInst: FastifyInstance, orgId: string, userId: string) {
      const headers = await sessionHeader(userId);
      const res = await request(appInst.server)
        .post('/api/v1/custom-dashboards')
        .set(headers)
        .send({ organizationId: orgId, name: `dash-${Date.now()}` });
      if (res.status !== 201) throw new Error(`Failed to create dashboard: ${JSON.stringify(res.body)}`);
      return res.body.dashboard as { id: string; name: string };
    }

    it('org B cannot GET org A dashboard (returns 404)', async () => {
      const t = await createIsolatedTenants();
      const dashA = await createDashboard(app, t.orgA.id, t.orgA.ownerUserId);
      const headersB = await sessionHeader(t.orgB.ownerUserId);

      const res = await request(app.server)
        .get(`/api/v1/custom-dashboards/${dashA.id}`)
        .query({ organizationId: t.orgB.id })
        .set(headersB);

      // Correct: dashboard belongs to orgA, not orgB → not found
      expect([403, 404]).toContain(res.status);
    });

    it('org B PUT on org A dashboard does not mutate org A data', async () => {
      const t = await createIsolatedTenants();
      const dashA = await createDashboard(app, t.orgA.id, t.orgA.ownerUserId);
      const headersB = await sessionHeader(t.orgB.ownerUserId);

      // The route passes orgB.id to the service which fails to find the row
      // and the NoResultError becomes a 500. In any case org A data is unchanged.
      await request(app.server)
        .put(`/api/v1/custom-dashboards/${dashA.id}`)
        .query({ organizationId: t.orgB.id })
        .set(headersB)
        .send({ name: 'hacked' });

      // The original dashboard for org A must still have its original name
      const headersA = await sessionHeader(t.orgA.ownerUserId);
      const check = await request(app.server)
        .get(`/api/v1/custom-dashboards/${dashA.id}`)
        .query({ organizationId: t.orgA.id })
        .set(headersA)
        .expect(200);
      expect(check.body.dashboard.name).toBe(dashA.name);
    });

    it('org B DELETE on org A dashboard id does NOT actually delete org A data', async () => {
      const t = await createIsolatedTenants();
      const dashA = await createDashboard(app, t.orgA.id, t.orgA.ownerUserId);
      const headersB = await sessionHeader(t.orgB.ownerUserId);

      // DELETE with orgB.id in query param: service scopes by organization_id,
      // finds no matching row, silently no-ops. HTTP may return 204 or 404.
      await request(app.server)
        .delete(`/api/v1/custom-dashboards/${dashA.id}`)
        .query({ organizationId: t.orgB.id })
        .set(headersB);

      // Critical: org A's dashboard must still exist
      const headersA = await sessionHeader(t.orgA.ownerUserId);
      const check = await request(app.server)
        .get(`/api/v1/custom-dashboards/${dashA.id}`)
        .query({ organizationId: t.orgA.id })
        .set(headersA);
      expect(check.status).toBe(200);
      expect(check.body.dashboard.id).toBe(dashA.id);
    });
  });
});
