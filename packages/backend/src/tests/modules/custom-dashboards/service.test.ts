import { describe, it, expect, beforeEach } from 'vitest';
import { CustomDashboardsService } from '../../../modules/custom-dashboards/service.js';
import { createTestContext } from '../../helpers/index.js';

let service: CustomDashboardsService;
let ctx: Awaited<ReturnType<typeof createTestContext>>;

beforeEach(async () => {
  service = new CustomDashboardsService();
  ctx = await createTestContext();
});

// Minimal valid panel for tests
function makePanel(id = 'panel-1') {
  return {
    id,
    layout: { x: 0, y: 0, w: 4, h: 3 },
    config: {
      type: 'time_series' as const,
      title: 'Logs',
      source: 'logs' as const,
      projectId: null,
      interval: '24h' as const,
      levels: ['info'] as ['info'],
      service: null,
    },
  };
}

describe('CustomDashboardsService.create', () => {
  it('creates a dashboard with no panels', async () => {
    const d = await service.create(
      { organizationId: ctx.organization.id, name: 'My Dashboard' },
      ctx.user.id
    );
    expect(d.id).toBeDefined();
    expect(d.name).toBe('My Dashboard');
    expect(d.panels).toEqual([]);
    expect(d.isDefault).toBe(false);
    expect(d.organizationId).toBe(ctx.organization.id);
  });

  it('creates a dashboard with panels', async () => {
    const panel = makePanel();
    const d = await service.create(
      { organizationId: ctx.organization.id, name: 'With panels', panels: [panel] },
      ctx.user.id
    );
    expect(d.panels).toHaveLength(1);
    expect(d.panels[0].id).toBe('panel-1');
  });

  it('creates a personal dashboard', async () => {
    const d = await service.create(
      { organizationId: ctx.organization.id, name: 'My personal', isPersonal: true },
      ctx.user.id
    );
    expect(d.isPersonal).toBe(true);
  });

  it('creates a project-scoped dashboard', async () => {
    const d = await service.create(
      {
        organizationId: ctx.organization.id,
        projectId: ctx.project.id,
        name: 'Project dash',
      },
      ctx.user.id
    );
    expect(d.projectId).toBe(ctx.project.id);
  });
});

describe('CustomDashboardsService.list', () => {
  it('lists all dashboards for an organization', async () => {
    await service.create({ organizationId: ctx.organization.id, name: 'D1' }, ctx.user.id);
    await service.create({ organizationId: ctx.organization.id, name: 'D2' }, ctx.user.id);

    const list = await service.list(ctx.organization.id, ctx.user.id);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it('hides other users personal dashboards', async () => {
    const { createTestUser } = await import('../../helpers/factories.js');
    const { createTestSession } = await import('../../helpers/auth.js');
    const otherUser = await createTestUser();
    await import('../../../database/index.js').then(({ db }) =>
      db.insertInto('organization_members').values({
        user_id: otherUser.id,
        organization_id: ctx.organization.id,
        role: 'member',
      }).execute()
    );

    // Other user creates personal dashboard
    await service.create(
      { organizationId: ctx.organization.id, name: 'Private', isPersonal: true },
      otherUser.id
    );

    // Our user should NOT see it
    const list = await service.list(ctx.organization.id, ctx.user.id);
    expect(list.find((d) => d.name === 'Private')).toBeUndefined();
  });

  it('returns empty array when no dashboards', async () => {
    const list = await service.list(ctx.organization.id, ctx.user.id);
    expect(list).toHaveLength(0);
  });

  it('filters by projectId', async () => {
    const { createTestProject } = await import('../../helpers/factories.js');
    const p2 = await createTestProject({ organizationId: ctx.organization.id, userId: ctx.user.id });

    await service.create({ organizationId: ctx.organization.id, projectId: ctx.project.id, name: 'P1 dash' }, ctx.user.id);
    await service.create({ organizationId: ctx.organization.id, projectId: p2.id, name: 'P2 dash' }, ctx.user.id);

    const list = await service.list(ctx.organization.id, ctx.user.id, ctx.project.id);
    expect(list.every((d) => d.projectId === ctx.project.id || d.projectId === null)).toBe(true);
  });
});

describe('CustomDashboardsService.getById', () => {
  it('returns dashboard by id', async () => {
    const created = await service.create({ organizationId: ctx.organization.id, name: 'Find me' }, ctx.user.id);

    const found = await service.getById(created.id, ctx.organization.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Find me');
  });

  it('returns null for unknown id', async () => {
    const found = await service.getById('00000000-0000-0000-0000-000000000000', ctx.organization.id);
    expect(found).toBeNull();
  });
});

describe('CustomDashboardsService.update', () => {
  it('updates dashboard name', async () => {
    const d = await service.create({ organizationId: ctx.organization.id, name: 'Old' }, ctx.user.id);

    const updated = await service.update(d.id, ctx.organization.id, { name: 'New' });
    expect(updated.name).toBe('New');
  });

  it('updates panels', async () => {
    const d = await service.create({ organizationId: ctx.organization.id, name: 'Panels' }, ctx.user.id);

    const panel = makePanel('p-new');
    const updated = await service.update(d.id, ctx.organization.id, { panels: [panel] });
    expect(updated.panels).toHaveLength(1);
    expect(updated.panels[0].id).toBe('p-new');
  });

  it('updates description to null', async () => {
    const d = await service.create(
      { organizationId: ctx.organization.id, name: 'Desc', description: 'hello' },
      ctx.user.id
    );

    const updated = await service.update(d.id, ctx.organization.id, { description: null });
    expect(updated.description).toBeNull();
  });
});

describe('CustomDashboardsService.delete', () => {
  it('deletes a non-default dashboard', async () => {
    const d = await service.create({ organizationId: ctx.organization.id, name: 'Delete me' }, ctx.user.id);

    await service.delete(d.id, ctx.organization.id);

    const found = await service.getById(d.id, ctx.organization.id);
    expect(found).toBeNull();
  });

  it('throws when trying to delete the default dashboard', async () => {
    const d = await service.ensureDefaultExists(ctx.organization.id, ctx.user.id);

    await expect(service.delete(d.id, ctx.organization.id)).rejects.toThrow('Cannot delete the default dashboard');
  });

  it('throws Dashboard not found when the id does not exist in this org', async () => {
    await expect(
      service.delete('00000000-0000-0000-0000-000000000000', ctx.organization.id)
    ).rejects.toThrow('Dashboard not found');
  });
});

describe('CustomDashboardsService.ensureDefaultExists', () => {
  it('creates a default dashboard if none exists', async () => {
    const d = await service.ensureDefaultExists(ctx.organization.id, ctx.user.id);
    expect(d.isDefault).toBe(true);
    expect(d.name).toBe('Default');
    expect(d.panels.length).toBeGreaterThan(0);
  });

  it('returns existing default dashboard on second call', async () => {
    const d1 = await service.ensureDefaultExists(ctx.organization.id, ctx.user.id);
    const d2 = await service.ensureDefaultExists(ctx.organization.id, ctx.user.id);
    expect(d1.id).toBe(d2.id);
  });
});

describe('CustomDashboardsService.exportYaml', () => {
  it('exports a dashboard as YAML', async () => {
    const panel = makePanel();
    const d = await service.create(
      { organizationId: ctx.organization.id, name: 'Export test', panels: [panel] },
      ctx.user.id
    );

    const yaml = await service.exportYaml(d.id, ctx.organization.id);
    expect(yaml).toContain('name: Export test');
    expect(yaml).toContain('panels:');
  });

  it('throws for unknown dashboard', async () => {
    await expect(
      service.exportYaml('00000000-0000-0000-0000-000000000000', ctx.organization.id)
    ).rejects.toThrow('Dashboard not found');
  });
});

describe('CustomDashboardsService.importYaml', () => {
  it('imports a dashboard from YAML', async () => {
    const yamlText = `
name: Imported Dashboard
description: From YAML
schema_version: 1
panels:
  - id: panel-imported
    layout:
      x: 0
      y: 0
      w: 4
      h: 3
    config:
      type: time_series
      title: Logs
      source: logs
      projectId: null
      interval: "24h"
      levels:
        - info
      service: null
`;
    const d = await service.importYaml(yamlText, ctx.organization.id, ctx.user.id);
    expect(d.name).toBe('Imported Dashboard');
    expect(d.description).toBe('From YAML');
    expect(d.panels).toHaveLength(1);
  });

  it('throws for invalid YAML', async () => {
    await expect(
      service.importYaml(': invalid: yaml: {{{{', ctx.organization.id, ctx.user.id)
    ).rejects.toThrow(/Invalid YAML/);
  });

  it('throws when name is missing', async () => {
    const yamlText = 'description: No name\npanels: []\n';
    await expect(
      service.importYaml(yamlText, ctx.organization.id, ctx.user.id)
    ).rejects.toThrow(/name/);
  });

  it('throws when YAML is not a mapping', async () => {
    await expect(
      service.importYaml('- just\n- an\n- array\n', ctx.organization.id, ctx.user.id)
    ).rejects.toThrow();
  });

  it('generates fresh panel IDs on import', async () => {
    const yamlText = `
name: ID test
schema_version: 1
panels:
  - id: original-id
    layout: { x: 0, y: 0, w: 4, h: 3 }
    config:
      type: time_series
      title: T
      source: logs
      projectId: null
      interval: "24h"
      levels: [info]
      service: null
`;
    const d = await service.importYaml(yamlText, ctx.organization.id, ctx.user.id);
    expect(d.panels[0].id).not.toBe('original-id');
  });
});

describe('CustomDashboardsService.getDefaultLayoutFor', () => {
  it('returns layout for time_series', () => {
    const layout = service.getDefaultLayoutFor('time_series');
    expect(layout.w).toBeGreaterThan(0);
    expect(layout.h).toBeGreaterThan(0);
  });

  it('returns layout for single_stat', () => {
    const layout = service.getDefaultLayoutFor('single_stat');
    expect(layout.w).toBeDefined();
    expect(layout.h).toBeDefined();
  });
});

describe('CustomDashboardsService.setAsDefault', () => {
  it('promotes an org-wide dashboard to default', async () => {
    const d = await service.create(
      { organizationId: ctx.organization.id, name: 'D' },
      ctx.user.id
    );
    const result = await service.setAsDefault(d.id, ctx.organization.id);
    expect(result.id).toBe(d.id);
    expect(result.isDefault).toBe(true);
  });

  it('unsets previous default when promoting another', async () => {
    const a = await service.create(
      { organizationId: ctx.organization.id, name: 'A' },
      ctx.user.id
    );
    const b = await service.create(
      { organizationId: ctx.organization.id, name: 'B' },
      ctx.user.id
    );
    await service.setAsDefault(a.id, ctx.organization.id);
    await service.setAsDefault(b.id, ctx.organization.id);

    const list = await service.list(ctx.organization.id, ctx.user.id);
    const defaults = list.filter((x) => x.isDefault && x.projectId === null);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(b.id);
  });

  it('is idempotent when already default', async () => {
    const d = await service.create(
      { organizationId: ctx.organization.id, name: 'D' },
      ctx.user.id
    );
    await service.setAsDefault(d.id, ctx.organization.id);
    const again = await service.setAsDefault(d.id, ctx.organization.id);
    expect(again.id).toBe(d.id);
    expect(again.isDefault).toBe(true);
  });

  it('throws Dashboard not found for unknown id', async () => {
    await expect(
      service.setAsDefault('00000000-0000-0000-0000-000000000000', ctx.organization.id)
    ).rejects.toThrow('Dashboard not found');
  });

  it('refuses to promote a personal dashboard', async () => {
    const personal = await service.create(
      { organizationId: ctx.organization.id, name: 'Mine', isPersonal: true },
      ctx.user.id
    );
    await expect(service.setAsDefault(personal.id, ctx.organization.id)).rejects.toThrow(
      'Personal dashboards cannot be set as default'
    );
  });

  it('refuses to promote a project-scoped dashboard', async () => {
    const proj = await service.create(
      {
        organizationId: ctx.organization.id,
        projectId: ctx.project.id,
        name: 'Project D',
      },
      ctx.user.id
    );
    await expect(service.setAsDefault(proj.id, ctx.organization.id)).rejects.toThrow(
      'Project-scoped dashboards cannot be set as default'
    );
  });
});

describe('CustomDashboardsService.generatePanelId', () => {
  it('generates unique IDs', () => {
    const id1 = service.generatePanelId();
    const id2 = service.generatePanelId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^panel-/);
  });
});
