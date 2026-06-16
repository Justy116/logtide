import { describe, it, expect } from 'vitest';
import { Kysely, DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { TenantScopeGuardPlugin, TenantScopeError } from '../../database/tenant-scope-guard.js';

function makeGuardedDb() {
  return new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [new TenantScopeGuardPlugin()],
  });
}

describe('TenantScopeGuardPlugin', () => {
  it('throws on a tenant-table select with no org/project filter', async () => {
    const db = makeGuardedDb();
    await expect(db.selectFrom('alert_rules').selectAll().execute()).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('allows a tenant-table select filtered by organization_id', async () => {
    const db = makeGuardedDb();
    await expect(db.selectFrom('alert_rules').selectAll().where('organization_id', '=', 'o1').execute()).resolves.toBeDefined();
  });

  it('allows a tenant-table select filtered by project_id', async () => {
    const db = makeGuardedDb();
    await expect(db.selectFrom('logs').selectAll().where('project_id', '=', 'p1').execute()).resolves.toBeDefined();
  });

  it('ignores global tables', async () => {
    const db = makeGuardedDb();
    await expect(db.selectFrom('users').selectAll().execute()).resolves.toBeDefined();
  });

  it('ignores child tables', async () => {
    const db = makeGuardedDb();
    await expect(db.selectFrom('incident_comments').selectAll().execute()).resolves.toBeDefined();
  });

  it('throws on an unscoped delete of a tenant table', async () => {
    const db = makeGuardedDb();
    await expect(db.deleteFrom('sigma_rules').execute()).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('throws on an unscoped select of an aliased tenant table', async () => {
    const db = makeGuardedDb();
    await expect(
      db.selectFrom('logs as l').selectAll().execute()
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('allows an aliased tenant table filtered by project_id', async () => {
    const db = makeGuardedDb();
    await expect(
      db.selectFrom('logs as l').selectAll().where('l.project_id', '=', 'p1').execute()
    ).resolves.toBeDefined();
  });
});
