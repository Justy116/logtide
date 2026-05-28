import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'kysely';
import { db } from '../../database/connection.js';
import { repairMigrationTable, type MigrationRename } from '../../database/migration-repair.js';

// Use a synthetic test prefix so we never touch the real migration rows.
const PREFIX = 'test_repair_';

const TEST_NAMES = [
  `${PREFIX}042_digest_email_reports`,
  `${PREFIX}042_project_data_availability`,
  `${PREFIX}043_error_notification_throttle`,
  `${PREFIX}044_digest_email_reports`,
  `${PREFIX}037_monitor_notification_channels`,
  `${PREFIX}037a_monitor_notification_channels`,
  `${PREFIX}037_add_log_heartbeat_type`,
  `${PREFIX}038_add_grace_period`,
];

const TEST_RENAMES: MigrationRename[] = [
  {
    from: `${PREFIX}037_monitor_notification_channels`,
    to: `${PREFIX}037a_monitor_notification_channels`,
    bumpTimestamp: false,
  },
  {
    from: `${PREFIX}042_digest_email_reports`,
    to: `${PREFIX}044_digest_email_reports`,
    bumpTimestamp: true,
  },
];

async function clearTestRows() {
  await sql`DELETE FROM kysely_migration WHERE name = ANY(${TEST_NAMES})`.execute(db);
}

async function getRow(name: string) {
  const result = await sql<{ name: string; timestamp: string }>`
    SELECT name, timestamp FROM kysely_migration WHERE name = ${name}
  `.execute(db);
  return result.rows[0];
}

describe('repairMigrationTable', () => {
  beforeEach(async () => {
    await clearTestRows();
  });

  afterAll(async () => {
    await clearTestRows();
  });

  it('is a no-op on a fresh DB (no rows to rename)', async () => {
    await repairMigrationTable(db, TEST_RENAMES);

    expect(await getRow(`${PREFIX}037_monitor_notification_channels`)).toBeUndefined();
    expect(await getRow(`${PREFIX}042_digest_email_reports`)).toBeUndefined();
    expect(await getRow(`${PREFIX}037a_monitor_notification_channels`)).toBeUndefined();
    expect(await getRow(`${PREFIX}044_digest_email_reports`)).toBeUndefined();
  });

  it('renames the 037 row without touching its timestamp', async () => {
    const originalTs = '2026-04-06T01:45:00.000Z';
    await sql`
      INSERT INTO kysely_migration (name, timestamp)
      VALUES (${`${PREFIX}037_monitor_notification_channels`}, ${originalTs})
    `.execute(db);

    await repairMigrationTable(db, TEST_RENAMES);

    expect(await getRow(`${PREFIX}037_monitor_notification_channels`)).toBeUndefined();
    const renamed = await getRow(`${PREFIX}037a_monitor_notification_channels`);
    expect(renamed).toBeDefined();
    expect(renamed?.timestamp).toBe(originalTs);
  });

  it('renames the 042_digest row and bumps timestamp past predecessors', async () => {
    // Simulate a DB applied in old chronological order: digest at T_c
    // (smallest), project at T_d, error_notification at T_e.
    const digestTs = '2026-04-21T03:04:00.000Z';
    const projectTs = '2026-04-18T18:31:00.000Z';
    const errorTs = '2026-05-26T18:08:00.000Z';

    await sql`
      INSERT INTO kysely_migration (name, timestamp) VALUES
        (${`${PREFIX}042_digest_email_reports`}, ${digestTs}),
        (${`${PREFIX}042_project_data_availability`}, ${projectTs}),
        (${`${PREFIX}043_error_notification_throttle`}, ${errorTs})
    `.execute(db);

    await repairMigrationTable(db, TEST_RENAMES);

    expect(await getRow(`${PREFIX}042_digest_email_reports`)).toBeUndefined();
    const renamed = await getRow(`${PREFIX}044_digest_email_reports`);
    expect(renamed).toBeDefined();
    expect(new Date(renamed!.timestamp).getTime()).toBeGreaterThan(new Date(errorTs).getTime());
  });

  it('is idempotent (re-running is safe)', async () => {
    await sql`
      INSERT INTO kysely_migration (name, timestamp) VALUES
        (${`${PREFIX}037_monitor_notification_channels`}, '2026-04-06T01:45:00.000Z')
    `.execute(db);

    await repairMigrationTable(db, TEST_RENAMES);
    const first = await getRow(`${PREFIX}037a_monitor_notification_channels`);
    expect(first).toBeDefined();

    await repairMigrationTable(db, TEST_RENAMES);
    const second = await getRow(`${PREFIX}037a_monitor_notification_channels`);
    expect(second?.timestamp).toBe(first?.timestamp);
  });

  it('produces an order that satisfies kysely position validation (case 3: both 042s applied)', async () => {
    // Pre-rename order: 042_digest (T_c, smallest) < 042_project (T_d) < 043_error (T_e).
    // Without repair, kysely sort gives:
    //   ..., 042_digest, 042_project, 043_error
    // After repair (rename + timestamp bump):
    //   ..., 042_project, 043_error, 044_digest
    // matching the on-disk alphabetical file order.
    await sql`
      INSERT INTO kysely_migration (name, timestamp) VALUES
        (${`${PREFIX}042_digest_email_reports`}, '2026-04-21T03:04:00.000Z'),
        (${`${PREFIX}042_project_data_availability`}, '2026-04-18T18:31:00.000Z'),
        (${`${PREFIX}043_error_notification_throttle`}, '2026-05-26T18:08:00.000Z')
    `.execute(db);

    await repairMigrationTable(db, TEST_RENAMES);

    const ordered = await sql<{ name: string }>`
      SELECT name FROM kysely_migration
      WHERE name = ANY(${TEST_NAMES})
      ORDER BY timestamp, name
    `.execute(db);

    expect(ordered.rows.map((r) => r.name)).toEqual([
      `${PREFIX}042_project_data_availability`,
      `${PREFIX}043_error_notification_throttle`,
      `${PREFIX}044_digest_email_reports`,
    ]);
  });

  it('handles case 2: only 042_project applied, no digest row', async () => {
    // Worst-case pre-fix prod state: 042_project applied, 042_digest never ran.
    await sql`
      INSERT INTO kysely_migration (name, timestamp) VALUES
        (${`${PREFIX}042_project_data_availability`}, '2026-04-18T18:31:00.000Z')
    `.execute(db);

    await repairMigrationTable(db, TEST_RENAMES);

    // Repair should be a no-op on this row (it's not in the rename list).
    const project = await getRow(`${PREFIX}042_project_data_availability`);
    expect(project).toBeDefined();
    expect(project?.timestamp).toBe('2026-04-18T18:31:00.000Z');

    // No 044_digest row was created (kysely's migrator will create it when
    // it runs the file).
    expect(await getRow(`${PREFIX}044_digest_email_reports`)).toBeUndefined();
  });
});
