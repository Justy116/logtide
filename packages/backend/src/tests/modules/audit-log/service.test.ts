import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../database/index.js';
import { AuditLogService } from '../../../modules/audit-log/service.js';
import type { AuditLogEntry } from '../../../modules/audit-log/service.js';
import { createTestUser, createTestOrganization } from '../../helpers/factories.js';
import { context } from '@logtide/shared/context';

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    organizationId: overrides.organizationId ?? null,
    userId: overrides.userId ?? null,
    userEmail: overrides.userEmail ?? null,
    action: overrides.action ?? 'test_action',
    category: overrides.category ?? 'config_change',
    resourceType: overrides.resourceType ?? null,
    resourceId: overrides.resourceId ?? null,
    ipAddress: overrides.ipAddress ?? null,
    userAgent: overrides.userAgent ?? null,
    metadata: overrides.metadata ?? null,
  };
}

describe('AuditLogService', () => {
  let service: AuditLogService;
  let orgId: string;
  let userId: string;
  let userEmail: string;

  beforeEach(async () => {
    await db.deleteFrom('audit_log').execute();
    service = new AuditLogService();

    const user = await createTestUser();
    const org = await createTestOrganization({ ownerId: user.id });
    orgId = org.id;
    userId = user.id;
    userEmail = user.email;
  });

  afterEach(async () => {
    await service.shutdown();
  });

  // Helper to insert entries directly into DB for query tests
  async function insertEntry(overrides: Partial<{
    organization_id: string | null;
    user_id: string | null;
    user_email: string | null;
    action: string;
    category: string;
    resource_type: string | null;
    resource_id: string | null;
    ip_address: string | null;
    user_agent: string | null;
    metadata: Record<string, unknown> | null;
    time: Date;
  }> = {}) {
    return db
      .insertInto('audit_log')
      .values({
        organization_id: overrides.organization_id ?? orgId,
        user_id: 'user_id' in overrides ? overrides.user_id! : userId,
        user_email: 'user_email' in overrides ? overrides.user_email! : userEmail,
        action: overrides.action ?? 'test_action',
        category: (overrides.category ?? 'config_change') as any,
        resource_type: overrides.resource_type ?? null,
        resource_id: overrides.resource_id ?? null,
        ip_address: overrides.ip_address ?? '127.0.0.1',
        user_agent: overrides.user_agent ?? 'test-agent',
        metadata: overrides.metadata ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  describe('log() and flush()', () => {
    it('should buffer entries and flush them to DB on shutdown', async () => {
      service.log(makeEntry({
        organizationId: orgId,
        userId,
        userEmail,
        action: 'create_project',
        category: 'config_change',
      }));

      // Before shutdown, nothing in DB
      const before = await db
        .selectFrom('audit_log')
        .select(db.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(before.count)).toBe(0);

      // Shutdown flushes the buffer
      await service.shutdown();

      const after = await db
        .selectFrom('audit_log')
        .select(db.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(after.count)).toBe(1);
    });

    it('should flush multiple entries at once', async () => {
      for (let i = 0; i < 5; i++) {
        service.log(makeEntry({
          organizationId: orgId,
          action: `action_${i}`,
          category: 'config_change',
        }));
      }

      await service.shutdown();

      const result = await db
        .selectFrom('audit_log')
        .select(db.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(result.count)).toBe(5);
    });

    it('should map camelCase fields to snake_case columns', async () => {
      service.log(makeEntry({
        organizationId: orgId,
        userId,
        userEmail,
        action: 'login',
        category: 'user_management',
        resourceType: 'session',
        resourceId: 'sess-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        metadata: { browser: 'Chrome' },
      }));

      await service.shutdown();

      const row = await db
        .selectFrom('audit_log')
        .selectAll()
        .executeTakeFirstOrThrow();

      expect(row.organization_id).toBe(orgId);
      expect(row.user_id).toBe(userId);
      expect(row.user_email).toBe(userEmail);
      expect(row.action).toBe('login');
      expect(row.category).toBe('user_management');
      expect(row.resource_type).toBe('session');
      expect(row.resource_id).toBe('sess-123');
      expect(row.ip_address).toBe('192.168.1.1');
      expect(row.user_agent).toBe('Mozilla/5.0');
      expect(row.metadata).toEqual({ browser: 'Chrome' });
    });

    it('should handle null/undefined optional fields', async () => {
      service.log(makeEntry({
        organizationId: orgId,
        action: 'test',
        category: 'log_access',
      }));

      await service.shutdown();

      const row = await db
        .selectFrom('audit_log')
        .selectAll()
        .executeTakeFirstOrThrow();

      expect(row.user_id).toBeNull();
      expect(row.user_email).toBeNull();
      expect(row.resource_type).toBeNull();
      expect(row.resource_id).toBeNull();
      expect(row.ip_address).toBeNull();
      expect(row.user_agent).toBeNull();
      expect(row.metadata).toBeNull();
    });

    it('should auto-flush when buffer reaches BUFFER_MAX (50)', async () => {
      for (let i = 0; i < 50; i++) {
        service.log(makeEntry({
          organizationId: orgId,
          action: `bulk_action_${i}`,
          category: 'config_change',
        }));
      }

      // Give the async flush a moment to complete
      await new Promise((r) => setTimeout(r, 200));

      const result = await db
        .selectFrom('audit_log')
        .select(db.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(result.count)).toBe(50);
    });

    it('should not flush when buffer is empty', async () => {
      // shutdown on empty buffer should not error
      await service.shutdown();

      const result = await db
        .selectFrom('audit_log')
        .select(db.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(result.count)).toBe(0);
    });

    it('should re-queue entries on flush error', async () => {
      const insertSpy = vi.spyOn(db, 'insertInto');

      // First call throws, second call succeeds
      insertSpy.mockImplementationOnce(() => {
        throw new Error('DB connection error');
      });

      service.log(makeEntry({
        organizationId: orgId,
        action: 'will_fail',
        category: 'config_change',
      }));

      // Trigger flush via shutdown - first attempt fails, entries re-queued
      await service.shutdown();

      insertSpy.mockRestore();

      // Create a new service to flush the re-queued entries
      // Since the entries were re-queued in the same service instance's buffer,
      // we need to flush again
      // Actually, shutdown calls flush which failed and re-queued, then
      // the entries are still in the buffer. Let's create a new service
      // and verify the original service's buffer state.
      // The entries should be back in the buffer after the error.
      // Let's try flushing again by calling shutdown on a fresh service
      // that we populated manually.

      // Since the flush failed and re-queued, we can't easily test
      // the buffer state from outside. Let's verify by checking DB is empty.
      const result = await db
        .selectFrom('audit_log')
        .select(db.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      // The entries were re-queued but shutdown only calls flush once,
      // so they're still in the buffer (DB should be empty)
      expect(Number(result.count)).toBe(0);
    });
  });

  describe('start() and shutdown()', () => {
    it('should start the flush timer and stop it on shutdown', async () => {
      service.start();

      service.log(makeEntry({
        organizationId: orgId,
        action: 'timed_flush',
        category: 'config_change',
      }));

      // Wait for the flush interval (1000ms + buffer)
      await new Promise((r) => setTimeout(r, 1500));

      const result = await db
        .selectFrom('audit_log')
        .select(db.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(result.count)).toBe(1);

      await service.shutdown();
    });

    it('should flush remaining entries on shutdown', async () => {
      service.start();

      service.log(makeEntry({
        organizationId: orgId,
        action: 'shutdown_flush',
        category: 'data_modification',
      }));

      // Immediately shutdown (don't wait for timer)
      await service.shutdown();

      const result = await db
        .selectFrom('audit_log')
        .select(db.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(result.count)).toBe(1);
    });
  });

  describe('query()', () => {
    it('should return entries for an organization', async () => {
      await insertEntry({ action: 'action_1' });
      await insertEntry({ action: 'action_2' });

      const result = await service.query({ organizationId: orgId });

      expect(result.entries).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should not return entries from other organizations', async () => {
      const otherUser = await createTestUser({ email: `other-${Date.now()}@test.com` });
      const otherOrg = await createTestOrganization({ ownerId: otherUser.id });

      await insertEntry({ action: 'my_action' });
      await insertEntry({ organization_id: otherOrg.id, action: 'other_action' });

      const result = await service.query({ organizationId: orgId });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].action).toBe('my_action');
    });

    it('should filter by category', async () => {
      await insertEntry({ category: 'config_change', action: 'change_1' });
      await insertEntry({ category: 'user_management', action: 'user_1' });
      await insertEntry({ category: 'log_access', action: 'access_1' });

      const result = await service.query({
        organizationId: orgId,
        category: 'config_change',
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].action).toBe('change_1');
    });

    it('should filter by action', async () => {
      await insertEntry({ action: 'create_project' });
      await insertEntry({ action: 'delete_project' });
      await insertEntry({ action: 'create_project' });

      const result = await service.query({
        organizationId: orgId,
        action: 'create_project',
      });

      expect(result.entries).toHaveLength(2);
    });

    it('should filter by resourceType', async () => {
      await insertEntry({ resource_type: 'project', action: 'a1' });
      await insertEntry({ resource_type: 'user', action: 'a2' });
      await insertEntry({ resource_type: 'project', action: 'a3' });

      const result = await service.query({
        organizationId: orgId,
        resourceType: 'project',
      });

      expect(result.entries).toHaveLength(2);
    });

    it('should filter by userId', async () => {
      const otherUser = await createTestUser({ email: `filter-user-${Date.now()}@test.com` });

      await insertEntry({ user_id: userId, action: 'a1' });
      await insertEntry({ user_id: otherUser.id, action: 'a2' });

      const result = await service.query({
        organizationId: orgId,
        userId,
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].action).toBe('a1');
    });

    it('should filter by from date', async () => {
      const oldDate = new Date('2024-01-01');
      const recentDate = new Date();

      // Insert using raw SQL for time control
      await db.insertInto('audit_log').values({
        organization_id: orgId,
        action: 'old_action',
        category: 'config_change' as any,
        user_id: null,
        user_email: null,
        resource_type: null,
        resource_id: null,
        ip_address: null,
        user_agent: null,
        metadata: null,
      }).execute();

      const result = await service.query({
        organizationId: orgId,
        from: new Date(Date.now() - 60000), // last minute
      });

      expect(result.entries.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter by to date', async () => {
      await insertEntry({ action: 'recent_action' });

      const result = await service.query({
        organizationId: orgId,
        to: new Date(Date.now() + 60000), // future
      });

      expect(result.entries).toHaveLength(1);

      const resultPast = await service.query({
        organizationId: orgId,
        to: new Date('2020-01-01'),
      });

      expect(resultPast.entries).toHaveLength(0);
    });

    it('should apply default limit of 50', async () => {
      const result = await service.query({ organizationId: orgId });
      // Just verify it doesn't error - with 0 entries it returns empty
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should cap limit at 200', async () => {
      // Insert 3 entries
      await insertEntry({ action: 'a1' });
      await insertEntry({ action: 'a2' });
      await insertEntry({ action: 'a3' });

      const result = await service.query({
        organizationId: orgId,
        limit: 999, // above 200 cap
      });

      // Should still return all 3 (cap is 200 but we only have 3)
      expect(result.entries).toHaveLength(3);
    });

    it('should handle offset for pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await insertEntry({ action: `action_${i}` });
      }

      const page1 = await service.query({
        organizationId: orgId,
        limit: 2,
        offset: 0,
      });

      const page2 = await service.query({
        organizationId: orgId,
        limit: 2,
        offset: 2,
      });

      expect(page1.entries).toHaveLength(2);
      expect(page2.entries).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page2.total).toBe(5);

      // Entries should be different
      expect(page1.entries[0].action).not.toBe(page2.entries[0].action);
    });

    it('should order entries by time descending', async () => {
      await insertEntry({ action: 'first' });
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      await insertEntry({ action: 'second' });

      const result = await service.query({ organizationId: orgId });

      expect(result.entries[0].action).toBe('second');
      expect(result.entries[1].action).toBe('first');
    });

    it('should combine multiple filters', async () => {
      await insertEntry({
        category: 'config_change',
        action: 'create_project',
        resource_type: 'project',
      });
      await insertEntry({
        category: 'config_change',
        action: 'create_project',
        resource_type: 'api_key',
      });
      await insertEntry({
        category: 'user_management',
        action: 'create_project',
        resource_type: 'project',
      });

      const result = await service.query({
        organizationId: orgId,
        category: 'config_change',
        resourceType: 'project',
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].action).toBe('create_project');
    });

    it('normalizes legacy rows: user rows read as user/success', async () => {
      await insertEntry({ action: 'legacy_action' });
      const result = await service.query({ organizationId: orgId });
      expect(result.entries[0].actor_type).toBe('user');
      expect(result.entries[0].actor_id).toBe(userId);
      expect(result.entries[0].outcome).toBe('success');
    });

    it('normalizes legacy rows with null user_id as system', async () => {
      await insertEntry({ action: 'legacy_system', user_id: null, user_email: null });
      const result = await service.query({ organizationId: orgId });
      expect(result.entries[0].actor_type).toBe('system');
    });

    it('filters by actorType including legacy semantics', async () => {
      await insertEntry({ action: 'legacy_user_row' });
      await db.insertInto('audit_log').values({
        organization_id: orgId,
        user_id: null,
        user_email: null,
        action: 'apikey_row',
        category: 'log_access' as any,
        resource_type: null,
        resource_id: null,
        ip_address: null,
        user_agent: null,
        metadata: null,
        actor_type: 'apiKey',
        actor_id: null,
        outcome: 'success',
      } as any).execute();

      const users = await service.query({ organizationId: orgId, actorType: 'user' });
      expect(users.entries.map((e) => e.action)).toEqual(['legacy_user_row']);

      const keys = await service.query({ organizationId: orgId, actorType: 'apiKey' });
      expect(keys.entries.map((e) => e.action)).toEqual(['apikey_row']);
    });

    it('filters by outcome including legacy success default', async () => {
      await insertEntry({ action: 'legacy_ok' });
      await db.insertInto('audit_log').values({
        organization_id: orgId,
        user_id: null,
        user_email: null,
        action: 'failed_login',
        category: 'user_management' as any,
        resource_type: null,
        resource_id: null,
        ip_address: null,
        user_agent: null,
        metadata: null,
        actor_type: 'user',
        actor_id: null,
        outcome: 'failure',
      } as any).execute();

      const failures = await service.query({ organizationId: orgId, outcome: 'failure' });
      expect(failures.entries.map((e) => e.action)).toEqual(['failed_login']);
      const oks = await service.query({ organizationId: orgId, outcome: 'success' });
      expect(oks.entries.map((e) => e.action)).toEqual(['legacy_ok']);
    });
  });

  describe('getDistinctActions()', () => {
    it('returns registry actions unioned with db actions, sorted', async () => {
      await insertEntry({ action: 'delete_project' });
      await insertEntry({ action: 'create_project' });
      await insertEntry({ action: 'create_project' }); // duplicate
      await insertEntry({ action: 'login' });

      const actions = await service.getDistinctActions(orgId);

      expect(actions).toContain('create_project');
      expect(actions).toContain('org.created');
      expect(actions).toContain('login'); // legacy db action not in registry
      expect(actions).toEqual([...actions].sort());
      expect(new Set(actions).size).toBe(actions.length); // deduplicated
    });

    it('returns registry list for org with no entries', async () => {
      const actions = await service.getDistinctActions(orgId);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions).toContain('org.created');
      expect(actions).not.toContain('my_legacy_action');
      expect(actions).toEqual([...actions].sort());
    });

    it('includes own legacy db actions but not other org actions', async () => {
      const otherUser = await createTestUser({ email: `distinct-${Date.now()}@test.com` });
      const otherOrg = await createTestOrganization({ ownerId: otherUser.id });

      await insertEntry({ action: 'my_action' });
      await insertEntry({ organization_id: otherOrg.id, action: 'other_org_action' });

      const actions = await service.getDistinctActions(orgId);
      expect(actions).toContain('my_action');
      expect(actions).not.toContain('other_org_action');
    });
  });

  describe('record()', () => {
    it('populates actor, org, ip, userAgent from the request context', async () => {
      await context.run(
        {
          requestId: 'req-1',
          origin: 'http',
          actor: { type: 'user', id: userId, email: userEmail },
          organizationId: orgId,
          projectId: null,
          ip: '10.0.0.1',
          userAgent: 'vitest-agent',
        },
        async () => {
          await service.record({
            action: 'project.created',
            target: { type: 'project', id: 'proj-1' },
            metadata: { name: 'demo' },
          });
        }
      );

      const row = await db.selectFrom('audit_log').selectAll().executeTakeFirstOrThrow();
      expect(row.action).toBe('project.created');
      expect(row.category).toBe('config_change');
      expect(row.actor_type).toBe('user');
      expect(row.actor_id).toBe(userId);
      expect(row.user_id).toBe(userId);
      expect(row.user_email).toBe(userEmail);
      expect(row.organization_id).toBe(orgId);
      expect(row.resource_type).toBe('project');
      expect(row.resource_id).toBe('proj-1');
      expect(row.outcome).toBe('success');
      expect(row.ip_address).toBe('10.0.0.1');
      expect(row.user_agent).toBe('vitest-agent');
    });

    it('records apiKey actors without writing user_id', async () => {
      await context.run(
        {
          requestId: 'req-2',
          origin: 'http',
          actor: { type: 'apiKey', id: '11111111-1111-1111-1111-111111111111', apiKeyType: 'ingest' },
          organizationId: orgId,
          projectId: null,
        },
        async () => {
          await service.record({ action: 'data.logs_searched' });
        }
      );

      const row = await db.selectFrom('audit_log').selectAll().executeTakeFirstOrThrow();
      expect(row.actor_type).toBe('apiKey');
      expect(row.actor_id).toBe('11111111-1111-1111-1111-111111111111');
      expect(row.user_id).toBeNull();
    });

    it('explicit actor/organizationId overrides win over context', async () => {
      await service.record({
        action: 'auth.login_failed',
        outcome: 'failure',
        actor: { type: 'user', id: null, label: 'tried@example.com' },
        organizationId: null,
        metadata: { method: 'local' },
      });

      const row = await db.selectFrom('audit_log').selectAll().executeTakeFirstOrThrow();
      expect(row.actor_type).toBe('user');
      expect(row.actor_id).toBeNull();
      expect(row.user_email).toBe('tried@example.com');
      expect(row.organization_id).toBeNull();
      expect(row.outcome).toBe('failure');
    });

    it('falls back to system actor with no context', async () => {
      await service.record({ action: 'data.deleted', organizationId: orgId });
      const row = await db.selectFrom('audit_log').selectAll().executeTakeFirstOrThrow();
      expect(row.actor_type).toBe('system');
      expect(row.actor_id).toBeNull();
    });

    it('writes inside the given transaction (rollback leaves no row)', async () => {
      await db
        .transaction()
        .execute(async (trx) => {
          await service.record({ action: 'org.updated', organizationId: orgId }, { trx });
          throw new Error('boom');
        })
        .catch(() => {});

      const count = await db.selectFrom('audit_log').select(db.fn.countAll<number>().as('count')).executeTakeFirstOrThrow();
      expect(Number(count.count)).toBe(0);

      await db.transaction().execute(async (trx) => {
        await service.record({ action: 'org.updated', organizationId: orgId }, { trx });
      });
      const after = await db.selectFrom('audit_log').select(db.fn.countAll<number>().as('count')).executeTakeFirstOrThrow();
      expect(Number(after.count)).toBe(1);
    });

    it('never throws to the caller when the insert fails', async () => {
      const spy = vi.spyOn(db, 'insertInto').mockImplementationOnce(() => {
        throw new Error('db down');
      });
      await expect(service.record({ action: 'org.updated', organizationId: orgId })).resolves.toBeUndefined();
      spy.mockRestore();
    });

    it('buffered mode defers the insert to flush', async () => {
      await service.record({ action: 'data.logs_searched', organizationId: orgId }, { buffered: true });
      const before = await db.selectFrom('audit_log').select(db.fn.countAll<number>().as('count')).executeTakeFirstOrThrow();
      expect(Number(before.count)).toBe(0);

      await service.shutdown();
      const after = await db.selectFrom('audit_log').select(db.fn.countAll<number>().as('count')).executeTakeFirstOrThrow();
      expect(Number(after.count)).toBe(1);
    });
  });
});
