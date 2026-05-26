import { describe, it, expect, beforeEach } from 'vitest';
import { truncateAllTables, createTestOrganization, createTestUser } from '../../helpers/index.js';
import { db } from '../../../database/index.js';
import { CustomDashboardsService } from '../../../modules/custom-dashboards/service.js';

describe('custom dashboards personal filter (enforced in SQL)', () => {
  beforeEach(async () => { await truncateAllTables(); });

  it("does not return another user's personal dashboard", async () => {
    const owner = await createTestUser();
    const org = await createTestOrganization({ ownerId: owner.id });
    const other = await createTestUser();
    const svc = new CustomDashboardsService();

    await db.insertInto('custom_dashboards').values({
      organization_id: org.id,
      project_id: null,
      name: 'mine',
      is_personal: true,
      created_by: owner.id,
      panels: JSON.stringify([]),
    } as any).execute();

    const listedForOther = await svc.list(org.id, other.id);
    expect(listedForOther.find((d) => d.name === 'mine')).toBeUndefined();

    const listedForOwner = await svc.list(org.id, owner.id);
    expect(listedForOwner.find((d) => d.name === 'mine')).toBeDefined();
  });

  it('returns shared (non-personal) dashboards to any org member', async () => {
    const owner = await createTestUser();
    const org = await createTestOrganization({ ownerId: owner.id });
    const other = await createTestUser();
    const svc = new CustomDashboardsService();

    await db.insertInto('custom_dashboards').values({
      organization_id: org.id,
      project_id: null,
      name: 'shared',
      is_personal: false,
      created_by: owner.id,
      panels: JSON.stringify([]),
    } as any).execute();

    const listed = await svc.list(org.id, other.id);
    expect(listed.find((d) => d.name === 'shared')).toBeDefined();
  });
});
