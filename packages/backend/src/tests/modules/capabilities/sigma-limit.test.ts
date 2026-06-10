import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db } from '../../../database/index.js';
import { sigmaRoutes } from '../../../modules/sigma/routes.js';
import { contextPlugin } from '../../../context/index.js';
import { capabilities } from '../../../capabilities/index.js';
import { createTestContext } from '../../helpers/factories.js';

// Mock the SigmaHQ github client so sync tests never hit the network.
// The module is imported by sync-service.ts as a singleton; we replace its
// methods via spies inside each test that needs them.
vi.mock('../../../modules/sigma/github-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../modules/sigma/github-client.js')>();
  return {
    ...actual,
    sigmahqClient: {
      getLatestCommit: vi.fn().mockResolvedValue('test-commit-abc123'),
      fetchRulesByCategory: vi.fn().mockResolvedValue([]),
      fetchAllRules: vi.fn().mockResolvedValue([]),
      fetchRule: vi.fn().mockResolvedValue(''),
      getCategories: vi.fn().mockResolvedValue([]),
      buildCategoryTree: vi.fn().mockResolvedValue([]),
      getRulesForCategory: vi.fn().mockResolvedValue([]),
      searchRules: vi.fn().mockResolvedValue([]),
    },
  };
});

const VALID_SIGMA_YAML = `
title: Test Rule
id: a0000000-0000-0000-0000-000000000001
status: stable
level: medium
logsource:
    product: linux
detection:
    selection:
        message|contains: 'suspicious'
    condition: selection
`;

function makeYaml(n: number) {
  return `
title: Test Rule ${n}
id: a0000000-0000-0000-0000-${String(n).padStart(12, '0')}
status: stable
level: medium
logsource:
    product: linux
detection:
    selection:
        message|contains: 'suspicious${n}'
    condition: selection
`;
}

async function createTestSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  await db
    .insertInto('sessions')
    .values({ user_id: userId, token, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) })
    .execute();
  return token;
}

async function insertEnabledRule(organizationId: string, n = 1) {
  return db
    .insertInto('sigma_rules')
    .values({
      organization_id: organizationId,
      project_id: null,
      sigma_id: `sigma-enabled-${n}-${crypto.randomUUID()}`,
      title: `Enabled Rule ${n}`,
      description: null,
      level: 'medium',
      status: 'stable',
      logsource: { product: 'linux' },
      detection: { selection: { 'message|contains': 'test' }, condition: 'selection' },
      email_recipients: [],
      webhook_url: null,
      alert_rule_id: null,
      conversion_status: 'success',
      conversion_notes: '',
      tags: null,
      mitre_tactics: null,
      mitre_techniques: null,
      sigmahq_path: null,
      sigmahq_commit: null,
      last_synced_at: null,
      enabled: true,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function insertDisabledRule(organizationId: string, n = 99) {
  return db
    .insertInto('sigma_rules')
    .values({
      organization_id: organizationId,
      project_id: null,
      sigma_id: `sigma-disabled-${n}-${crypto.randomUUID()}`,
      title: `Disabled Rule ${n}`,
      description: null,
      level: 'medium',
      status: 'stable',
      logsource: { product: 'linux' },
      detection: { selection: { 'message|contains': 'test' }, condition: 'selection' },
      email_recipients: [],
      webhook_url: null,
      alert_rule_id: null,
      conversion_status: 'success',
      conversion_notes: '',
      tags: null,
      mitre_tactics: null,
      mitre_techniques: null,
      sigmahq_path: null,
      sigmahq_commit: null,
      last_synced_at: null,
      enabled: false,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

describe('sigma.max_active_rules enforcement', () => {
  let app: FastifyInstance;
  let orgId: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(contextPlugin);
    await app.register(sigmaRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('organization_entitlements').execute();
    await db.deleteFrom('sigma_rules').execute();
    const ctx = await createTestContext();
    orgId = ctx.organization.id;
    userId = ctx.user.id;
    token = await createTestSession(userId);
    capabilities.invalidate(orgId);
  });

  // -------------------------------------------------------------------------
  // Case 1: import blocked at limit
  // -------------------------------------------------------------------------
  it('blocks import when at the active-rule limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'sigma.max_active_rules', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);

    await insertEnabledRule(orgId, 1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sigma/import',
      headers: { Authorization: `Bearer ${token}` },
      payload: { yaml: VALID_SIGMA_YAML, organizationId: orgId },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('capability.sigma.max_active_rules.limit_reached');
  });

  // -------------------------------------------------------------------------
  // Case 2: toggle-enable blocked at limit
  // -------------------------------------------------------------------------
  it('blocks toggle-enable when at the active-rule limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'sigma.max_active_rules', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);

    await insertEnabledRule(orgId, 1);
    const disabled = await insertDisabledRule(orgId, 2);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sigma/rules/${disabled.id}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { organizationId: orgId, enabled: true },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('capability.sigma.max_active_rules.limit_reached');
  });

  // -------------------------------------------------------------------------
  // Case 3: toggle-disable always allowed at limit
  // -------------------------------------------------------------------------
  it('allows toggle-disable even at the active-rule limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'sigma.max_active_rules', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);

    const enabled = await insertEnabledRule(orgId, 1);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sigma/rules/${enabled.id}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { organizationId: orgId, enabled: false },
    });

    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Case 4: sync blocked atomically (no partial insert)
  // -------------------------------------------------------------------------
  it('blocks sync atomically when batch would exceed the limit', async () => {
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'sigma.max_active_rules', enabled: null, limit_value: 3 })
      .execute();
    capabilities.invalidate(orgId);

    await insertEnabledRule(orgId, 1);
    await insertEnabledRule(orgId, 2);

    // Mock the client to return 2 importable rules (unique paths not in DB yet)
    const { sigmahqClient } = await import('../../../modules/sigma/github-client.js');
    (sigmahqClient.fetchRulesByCategory as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { path: 'rules/linux/test1.yml', name: 'test1.yml', category: 'linux', downloadUrl: 'http://x/1', sha: 'sha1' },
      { path: 'rules/linux/test2.yml', name: 'test2.yml', category: 'linux', downloadUrl: 'http://x/2', sha: 'sha2' },
    ]);
    (sigmahqClient.fetchRule as ReturnType<typeof vi.fn>).mockResolvedValue(makeYaml(10));

    const countBefore = await db
      .selectFrom('sigma_rules')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sigma/sync',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        organizationId: orgId,
        selection: { categories: ['linux'] },
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('capability.sigma.max_active_rules.limit_reached');

    // No partial insert: count unchanged
    const countAfter = await db
      .selectFrom('sigma_rules')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst();
    expect(Number(countAfter?.count)).toBe(Number(countBefore?.count));
  });

  // -------------------------------------------------------------------------
  // Case 5: unlimited by default (no entitlement row)
  // -------------------------------------------------------------------------
  it('allows import when no limit is configured (unlimited default)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sigma/import',
      headers: { Authorization: `Bearer ${token}` },
      payload: { yaml: VALID_SIGMA_YAML, organizationId: orgId },
    });

    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Case 6: org isolation (org A at limit, org B can still import)
  // -------------------------------------------------------------------------
  it('does not block org B when org A is at the limit', async () => {
    // Org A: set limit 1, insert 1 enabled rule
    await db
      .insertInto('organization_entitlements')
      .values({ organization_id: orgId, capability: 'sigma.max_active_rules', enabled: null, limit_value: 1 })
      .execute();
    capabilities.invalidate(orgId);
    await insertEnabledRule(orgId, 1);

    // Org B: separate test context, no limit
    const ctxB = await createTestContext();
    const tokenB = await createTestSession(ctxB.user.id);
    capabilities.invalidate(ctxB.organization.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sigma/import',
      headers: { Authorization: `Bearer ${tokenB}` },
      payload: { yaml: VALID_SIGMA_YAML, organizationId: ctxB.organization.id },
    });

    expect(res.statusCode).toBe(200);
  });
});
