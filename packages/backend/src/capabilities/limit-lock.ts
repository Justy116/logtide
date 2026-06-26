import { sql } from 'kysely';
import { db } from '../database/connection.js';

// Namespace for the (int4, int4) Postgres advisory lock keyspace used by
// capability limit enforcement, kept distinct from other advisory locks.
const CAP_LOCK_NAMESPACE = 0x4c54; // 'LT'

/** Deterministic 32-bit signed hash (FNV-1a) for advisory lock keys. */
function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0; // coerce to signed int32 for pg_advisory_xact_lock(int4, int4)
}

/**
 * Serialize a "count current usage -> assert under limit -> create" sequence
 * against concurrent callers for the same (organization, capability).
 *
 * The enforcement pattern (COUNT -> assertWithinLimit -> insert) is a
 * check-then-act: without serialization, parallel requests can each read a count
 * below the limit and then all insert, pushing usage past a finite cap. Wrapping
 * the count+create in this helper takes a transaction-scoped Postgres advisory
 * lock keyed by org+capability, so concurrent creators of the same resource type
 * run one at a time. The lock is released automatically on commit/rollback.
 *
 * Different organizations and different capabilities use distinct keys and do
 * not contend. When no finite limit is configured (the OSS default) the only
 * added cost is one advisory lock/unlock round-trip.
 */
export async function withLimitLock<T>(
  organizationId: string,
  capabilityKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key2 = hash32(`${organizationId}:${capabilityKey}`);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${CAP_LOCK_NAMESPACE}, ${key2})`.execute(trx);
    return fn();
  });
}
