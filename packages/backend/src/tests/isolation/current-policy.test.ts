/**
 * Current access policy assertions (not security guarantees).
 *
 * Today: an org member (session auth) can list/access ALL projects in their
 * own org.  orgA has 2 projects (A1, A2); the owner user sees both.
 *
 * Current policy; per-project RBAC may narrow this later - update here, not
 * in the security guarantees.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import { build } from '../../server.js';
import { truncateAllTables } from '../helpers/index.js';
import { createTestSession } from '../helpers/auth.js';
import { createIsolatedTenants } from './helpers.js';

async function sessionHeader(userId: string) {
  const session = await createTestSession(userId);
  return { Authorization: `Bearer ${session.token}` };
}

describe('Current access policy', () => {
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

  it('org A owner sees both A1 and A2 projects when listing projects', async () => {
    const t = await createIsolatedTenants();
    const headers = await sessionHeader(t.orgA.ownerUserId);

    const res = await request(app.server)
      .get('/api/v1/projects')
      .query({ organizationId: t.orgA.id })
      .set(headers)
      .expect(200);

    const ids: string[] = res.body.projects.map((p: any) => p.id);
    expect(ids).toContain(t.orgA.projects[0].id);
    expect(ids).toContain(t.orgA.projects[1].id);
    // Exactly 2 projects
    expect(ids).toHaveLength(2);
  });

  it('org A owner can GET each project individually', async () => {
    const t = await createIsolatedTenants();
    const headers = await sessionHeader(t.orgA.ownerUserId);

    for (const p of t.orgA.projects) {
      const res = await request(app.server)
        .get(`/api/v1/projects/${p.id}`)
        .set(headers)
        .expect(200);
      expect(res.body.project.id).toBe(p.id);
    }
  });

  it('org A owner cannot see org B projects', async () => {
    const t = await createIsolatedTenants();
    const headers = await sessionHeader(t.orgA.ownerUserId);

    const res = await request(app.server)
      .get('/api/v1/projects')
      .query({ organizationId: t.orgB.id })
      .set(headers);

    // Must be 403 (not a member of org B)
    expect(res.status).toBe(403);
  });

  it('org A owner can list alert rules for both A1 and A2 via org-scoped query', async () => {
    const t = await createIsolatedTenants();
    const headers = await sessionHeader(t.orgA.ownerUserId);

    // Org-level alert rules list: returns all rules in the org (both projects)
    const res = await request(app.server)
      .get('/api/v1/alerts')
      .query({ organizationId: t.orgA.id })
      .set(headers)
      .expect(200);

    // No rules yet, but the query is allowed and returns empty
    expect(Array.isArray(res.body.alertRules)).toBe(true);
  });

  it('org A owner cannot list alert rules for org B', async () => {
    const t = await createIsolatedTenants();
    const headers = await sessionHeader(t.orgA.ownerUserId);

    const res = await request(app.server)
      .get('/api/v1/alerts')
      .query({ organizationId: t.orgB.id })
      .set(headers);

    expect(res.status).toBe(403);
  });

  it('org A owner can read sigma rules for own org', async () => {
    const t = await createIsolatedTenants();
    const headers = await sessionHeader(t.orgA.ownerUserId);

    const res = await request(app.server)
      .get('/api/v1/sigma/rules')
      .query({ organizationId: t.orgA.id })
      .set(headers)
      .expect(200);

    expect(Array.isArray(res.body.rules)).toBe(true);
  });

  it('org A owner cannot read sigma rules for org B', async () => {
    const t = await createIsolatedTenants();
    const headers = await sessionHeader(t.orgA.ownerUserId);

    const res = await request(app.server)
      .get('/api/v1/sigma/rules')
      .query({ organizationId: t.orgB.id })
      .set(headers);

    expect(res.status).toBe(403);
  });
});
