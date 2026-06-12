import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { db } from '../../../database/index.js';
import { retentionService } from '../../../modules/retention/service.js';
import { createTestUser, createTestOrganization } from '../../helpers/factories.js';

async function seedAuditRow(orgId: string, ageDays: number) {
  await sql`
    INSERT INTO audit_log (time, organization_id, action, category)
    VALUES (NOW() - make_interval(days => ${ageDays}), ${orgId}, 'org.updated', 'config_change')
  `.execute(db);
}

describe('audit retention', () => {
  let orgA: any;
  let orgB: any;

  beforeEach(async () => {
    await db.deleteFrom('audit_log').execute();
    const userA = await createTestUser();
    orgA = await createTestOrganization({ ownerId: userA.id });
    const userB = await createTestUser({ email: `b-${Date.now()}@test.com` });
    orgB = await createTestOrganization({ ownerId: userB.id });
  });

  it('updates and validates audit retention days', async () => {
    await retentionService.updateOrganizationAuditRetention(orgA.id, 30);
    const org = await db.selectFrom('organizations').selectAll().where('id', '=', orgA.id).executeTakeFirstOrThrow();
    expect(org.audit_retention_days).toBe(30);

    await retentionService.updateOrganizationAuditRetention(orgA.id, null);
    const org2 = await db.selectFrom('organizations').selectAll().where('id', '=', orgA.id).executeTakeFirstOrThrow();
    expect(org2.audit_retention_days).toBeNull();

    await expect(retentionService.updateOrganizationAuditRetention(orgA.id, 0)).rejects.toThrow();
    await expect(retentionService.updateOrganizationAuditRetention(orgA.id, 4000)).rejects.toThrow();
    await expect(retentionService.updateOrganizationAuditRetention('00000000-0000-0000-0000-000000000000', 30)).rejects.toThrow();
  });

  it('deletes only expired rows of orgs with a retention window', async () => {
    await retentionService.updateOrganizationAuditRetention(orgA.id, 30);
    await seedAuditRow(orgA.id, 60);
    await seedAuditRow(orgA.id, 5);
    await seedAuditRow(orgB.id, 400);

    const summary = await retentionService.executeAuditRetentionForAllOrganizations();
    expect(summary.totalEntriesDeleted).toBe(1);
    expect(summary.totalOrganizations).toBe(1);

    const remaining = await db.selectFrom('audit_log').select(['organization_id']).execute();
    expect(remaining).toHaveLength(2);
    expect(remaining.filter((r) => r.organization_id === orgB.id)).toHaveLength(1);
  });

  it('is a no-op when no org has audit retention configured', async () => {
    await seedAuditRow(orgA.id, 400);
    const summary = await retentionService.executeAuditRetentionForAllOrganizations();
    expect(summary.totalEntriesDeleted).toBe(0);
    expect(summary.totalOrganizations).toBe(0);
  });
});
