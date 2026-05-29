import { Kysely, sql } from 'kysely';

/**
 * Maps old kysely_migration row names to new names after we renamed the
 * physical migration files to avoid duplicate numeric prefixes.
 *
 * Why: kysely tracks applied migrations by name. If we just rename the files,
 * any DB that already applied the old name will see the row as a "missing"
 * migration AND the new file as unapplied, which corrupts the order check.
 * This script renames the existing rows in place so kysely sees a consistent
 * state. Idempotent: if the old name is not present (fresh DB or already
 * repaired), each step is a no-op.
 */
export type MigrationRename = {
  from: string;
  to: string;
  /**
   * If true, also rewrite the row's timestamp to be greater than the max
   * timestamp of any row whose name sorts alphabetically before `to`. Needed
   * when the new name moves the row to a later alphabetical position, so the
   * kysely (timestamp, name) sort order matches the new file sort order.
   */
  bumpTimestamp: boolean;
};

export const DEFAULT_RENAMES: MigrationRename[] = [
  // 037_monitor_notification_channels was added the same day as
  // 037_add_log_heartbeat_type. Alphabetical order matches chronological
  // order so no DB hit the corruption error, but the duplicate prefix is
  // still rejected by the CI guard. New name keeps its position between
  // 037_add_log_heartbeat_type and 038_add_grace_period, so the existing
  // timestamp is fine.
  {
    from: '037_monitor_notification_channels',
    to: '037a_monitor_notification_channels',
    bumpTimestamp: false,
  },
  // 042_digest_email_reports was merged AFTER 042_project_data_availability
  // but sorted alphabetically BEFORE it, which broke any DB that applied
  // project_data_availability before the digest merge. New name (044_*)
  // moves it after 043_error_notification_throttle, so on DBs that already
  // applied the old name we must also push its timestamp past the
  // surrounding rows.
  {
    from: '042_digest_email_reports',
    to: '044_digest_email_reports',
    bumpTimestamp: true,
  },
];

export async function repairMigrationTable(
  db: Kysely<any>,
  renames: MigrationRename[] = DEFAULT_RENAMES,
): Promise<void> {
  const tableExists = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'kysely_migration'
    ) AS "exists"
  `.execute(db);

  if (!tableExists.rows[0]?.exists) {
    return;
  }

  for (const rename of renames) {
    const existing = await sql<{ name: string; timestamp: string }>`
      SELECT name, timestamp FROM kysely_migration WHERE name = ${rename.from}
    `.execute(db);

    if (existing.rows.length === 0) {
      continue;
    }

    if (rename.bumpTimestamp) {
      const predecessor = await sql<{ max_ts: string | null }>`
        SELECT MAX(timestamp) AS max_ts
        FROM kysely_migration
        WHERE name < ${rename.to} AND name <> ${rename.from}
      `.execute(db);

      const maxTs = predecessor.rows[0]?.max_ts;
      const newTs = maxTs
        ? new Date(new Date(maxTs).getTime() + 1).toISOString()
        : new Date().toISOString();

      await sql`
        UPDATE kysely_migration
        SET name = ${rename.to}, timestamp = ${newTs}
        WHERE name = ${rename.from}
      `.execute(db);
    } else {
      await sql`
        UPDATE kysely_migration
        SET name = ${rename.to}
        WHERE name = ${rename.from}
      `.execute(db);
    }

    console.log(`[migration-repair] renamed ${rename.from} -> ${rename.to}`);
  }
}
