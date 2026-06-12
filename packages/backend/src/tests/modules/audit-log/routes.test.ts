import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { db } from '../../../database/index.js';
import { auditLogRoutes } from '../../../modules/audit-log/routes.js';
import { createTestUser, createTestOrganization } from '../../helpers/factories.js';
import crypto from 'crypto';

async function createTestSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db
    .insertInto('sessions')
    .values({
      user_id: userId,
      token,
      expires_at: expiresAt,
    })
    .execute();

  return { token, expiresAt };
}

async function createAdminUser() {
  const user = await createTestUser({ email: `admin-${Date.now()}@test.com`, name: 'Admin User' });
  await db
    .updateTable('users')
    .set({ is_admin: true })
    .where('id', '=', user.id)
    .execute();
  return { ...user, is_admin: true };
}

async function insertAuditEntry(overrides: {
  organization_id: string;
  user_id?: string | null;
  user_email?: string | null;
  action?: string;
  category?: string;
  resource_type?: string | null;
  resource_id?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  metadata?: Record<string, unknown> | null;
  actor_type?: string | null;
  outcome?: string | null;
}) {
  return db
    .insertInto('audit_log')
    .values({
      organization_id: overrides.organization_id,
      user_id: overrides.user_id ?? null,
      user_email: overrides.user_email ?? null,
      action: overrides.action ?? 'test_action',
      category: (overrides.category ?? 'config_change') as any,
      resource_type: overrides.resource_type ?? null,
      resource_id: overrides.resource_id ?? null,
      ip_address: overrides.ip_address ?? '127.0.0.1',
      user_agent: overrides.user_agent ?? 'test-agent',
      metadata: overrides.metadata ?? null,
      actor_type: (overrides.actor_type ?? null) as any,
      outcome: (overrides.outcome ?? null) as any,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

describe('Audit Log Routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let userToken: string;
  let adminUser: any;
  let regularUser: any;
  let testOrg: any;

  beforeAll(async () => {
    app = Fastify();
    await app.register(auditLogRoutes, { prefix: '/api/v1/admin/audit-log' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('audit_log').execute();
    await db.deleteFrom('sessions').execute();
    await db.deleteFrom('organization_members').execute();
    await db.deleteFrom('projects').execute();
    await db.deleteFrom('organizations').execute();
    await db.deleteFrom('users').execute();

    adminUser = await createAdminUser();
    const adminSession = await createTestSession(adminUser.id);
    adminToken = adminSession.token;

    regularUser = await createTestUser({ email: 'regular@test.com' });
    const userSession = await createTestSession(regularUser.id);
    userToken = userSession.token;

    testOrg = await createTestOrganization({ ownerId: adminUser.id });
  });

  describe('Authentication & Authorization', () => {
    it('should return 401 without auth token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 for non-admin users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/admin/audit-log', () => {
    it('should return audit log entries', async () => {
      await insertAuditEntry({
        organization_id: testOrg.id,
        user_id: adminUser.id,
        user_email: adminUser.email,
        action: 'create_project',
        category: 'config_change',
        resource_type: 'project',
        resource_id: 'proj-123',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('entries');
      expect(body).toHaveProperty('total');
      expect(body.entries).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.entries[0].action).toBe('create_project');
    });

    it('should return empty result when no entries exist', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.entries).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('should return 400 when organizationId is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-log',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Validation error');
    });

    it('should return 400 for invalid organizationId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-log?organizationId=not-a-uuid',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should filter by category', async () => {
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'change_1',
        category: 'config_change',
      });
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'user_1',
        category: 'user_management',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&category=config_change`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].action).toBe('change_1');
    });

    it('should return 400 for invalid category', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&category=invalid_category`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should filter by action', async () => {
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'create_project',
      });
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'delete_project',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&action=create_project`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].action).toBe('create_project');
    });

    it('should filter by resourceType', async () => {
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'a1',
        resource_type: 'project',
      });
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'a2',
        resource_type: 'user',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&resourceType=project`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].resource_type).toBe('project');
    });

    it('should filter by userId', async () => {
      await insertAuditEntry({
        organization_id: testOrg.id,
        user_id: adminUser.id,
        action: 'admin_action',
      });
      await insertAuditEntry({
        organization_id: testOrg.id,
        user_id: regularUser.id,
        action: 'user_action',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&userId=${adminUser.id}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].action).toBe('admin_action');
    });

    it('should filter by from/to date range', async () => {
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'recent_action',
      });

      const from = new Date(Date.now() - 60000).toISOString();
      const to = new Date(Date.now() + 60000).toISOString();

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&from=${from}&to=${to}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.entries).toHaveLength(1);
    });

    it('should handle pagination with limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await insertAuditEntry({
          organization_id: testOrg.id,
          action: `action_${i}`,
        });
      }

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&limit=2&offset=0`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.entries).toHaveLength(2);
      expect(body.total).toBe(5);
    });

    it('should return 400 for limit below 1', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&limit=0`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for limit above 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&limit=201`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for negative offset', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&offset=-1`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/admin/audit-log/actions', () => {
    it('should return distinct actions', async () => {
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'create_project',
      });
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'delete_project',
      });
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'create_project', // duplicate
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/actions?organizationId=${testOrg.id}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('actions');
      // registry union: create_project and delete_project are in the registry; result is sorted
      expect(body.actions).toContain('create_project');
      expect(body.actions).toContain('delete_project');
      expect(body.actions).toContain('org.created');
      expect(body.actions).toEqual([...body.actions].sort());
    });

    it('returns registry actions even when org has no entries', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/actions?organizationId=${testOrg.id}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.actions.length).toBeGreaterThan(0);
      expect(body.actions).toContain('org.created');
      expect(body.actions).toEqual([...body.actions].sort());
    });

    it('should return 401 without auth token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/actions?organizationId=${testOrg.id}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 for non-admin users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/actions?organizationId=${testOrg.id}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 400 when organizationId is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-log/actions',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for invalid organizationId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-log/actions?organizationId=not-a-uuid',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/admin/audit-log/export', () => {
    it('should export audit logs as CSV', async () => {
      await insertAuditEntry({
        organization_id: testOrg.id,
        user_email: 'test@example.com',
        action: 'test_action',
        category: 'config_change',
        metadata: { foo: 'bar' },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/export?organizationId=${testOrg.id}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment; filename="audit-log-');
      
      const lines = response.payload.split('\n');
      expect(lines[0]).toBe('Time,User,Actor Type,Outcome,Category,Action,Resource Type,Resource ID,IP Address,User Agent,Details');
      expect(lines[1]).toContain('test@example.com');
      expect(lines[1]).toContain('test_action');
      expect(lines[1]).toContain('config_change');
      expect(lines[1]).toContain('"{""foo"":""bar""}"');
    });

    it('should filter export by category', async () => {
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'action1',
        category: 'config_change',
      });
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'action2',
        category: 'user_management',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/export?organizationId=${testOrg.id}&category=config_change`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const lines = response.payload.trim().split('\n');
      expect(lines).toHaveLength(2); // Header + 1 row
      expect(lines[1]).toContain('action1');
      expect(lines[1]).not.toContain('action2');
    });

    it('should handle large exports with pagination', async () => {
      // Insert 250 entries to trigger at least one loop (CHUNK_SIZE is 200)
      const entries = Array.from({ length: 250 }).map((_, i) => ({
        organization_id: testOrg.id,
        action: `action_${i}`,
        category: 'config_change',
      }));

      // Bulk insert for speed
      for (const entry of entries) {
        await insertAuditEntry(entry);
      }

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/export?organizationId=${testOrg.id}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const lines = response.payload.trim().split('\n');
      expect(lines).toHaveLength(251); // Header + 250 rows
    });

    it('should return 401 without auth token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/export?organizationId=${testOrg.id}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 for non-admin users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/export?organizationId=${testOrg.id}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 400 for invalid query parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/export?organizationId=${testOrg.id}&category=invalid`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should escape CSV values correctly', async () => {
      await insertAuditEntry({
        organization_id: testOrg.id,
        action: 'Action with, comma and "quotes"',
        category: 'config_change',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/export?organizationId=${testOrg.id}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.payload).toContain('"Action with, comma and ""quotes"""');
    });

    it('csv export includes actor type and outcome columns', async () => {
      await insertAuditEntry({
        organization_id: testOrg.id,
        user_email: 'test@example.com',
        action: 'test_action',
        category: 'config_change',
        actor_type: 'apiKey',
        outcome: 'failure',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log/export?organizationId=${testOrg.id}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const lines = response.payload.split('\n');
      expect(lines[0]).toBe('Time,User,Actor Type,Outcome,Category,Action,Resource Type,Resource ID,IP Address,User Agent,Details');
      expect(lines[1]).toContain('apiKey');
      expect(lines[1]).toContain('failure');
    });
  });

  describe('GET /api/v1/admin/audit-log - actorType and outcome filters', () => {
    it('filters by actorType and outcome', async () => {
      // legacy row with null actor_type/outcome (normalizes to user/success)
      await insertAuditEntry({
        organization_id: testOrg.id,
        user_id: adminUser.id,
        action: 'legacy_row',
        category: 'config_change',
      });
      // explicit apiKey failure row
      await insertAuditEntry({
        organization_id: testOrg.id,
        user_id: null,
        action: 'key_failure',
        category: 'config_change',
        actor_type: 'apiKey',
        outcome: 'failure',
      });

      const byActorType = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&actorType=apiKey`,
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(byActorType.statusCode).toBe(200);
      const byActorBody = JSON.parse(byActorType.payload);
      expect(byActorBody.entries.map((e: any) => e.action)).toEqual(['key_failure']);

      const byOutcome = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&outcome=success`,
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(byOutcome.statusCode).toBe(200);
      const byOutcomeBody = JSON.parse(byOutcome.payload);
      expect(byOutcomeBody.entries.map((e: any) => e.action)).toEqual(['legacy_row']);
    });

    it('rejects invalid actorType', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&actorType=robot`,
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects invalid outcome', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-log?organizationId=${testOrg.id}&outcome=maybe`,
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
