import { sql } from 'kysely';
import { db } from '../../database/index.js';
import type { MeteringEventType } from './types.js';

export type UsageGroupBy = 'type' | 'project' | 'day';

export interface UsageAggregateParams {
  organizationId: string;
  from: Date;
  to: Date;
  groupBy: UsageGroupBy;
  type?: MeteringEventType;
}

export interface UsageRow {
  type: string;
  project_id?: string | null;
  bucket?: string;
  quantity: number;
}

interface RawRow {
  type: string;
  project_id?: string | null;
  bucket?: Date | string;
  quantity: number | string;
}

export class MeteringService {
  /**
   * Aggregate usage for a single organization over [from, to).
   * Query-time grouping (no continuous aggregates). Always org-scoped.
   */
  /**
   * Sum of the LATEST event per (organization, project) for a gauge-type signal
   * (e.g. storage.snapshot). Used by the quota evaluator's point_in_time window:
   * snapshots are gauges, so history must never be summed.
   */
  async latestPointInTime(organizationId: string, type: MeteringEventType): Promise<number> {
    const query = sql<{ total: number | string | null }>`
      SELECT COALESCE(SUM(quantity), 0)::float8 AS total FROM (
        SELECT DISTINCT ON (project_id) quantity
        FROM metering_events
        WHERE organization_id = ${organizationId} AND type = ${type}
        ORDER BY project_id, time DESC
      ) t`;
    const result = await query.execute(db);
    const total = result.rows[0]?.total ?? 0;
    return typeof total === 'number' ? total : parseFloat(total ?? '0');
  }

  /**
   * Daily storage trend: for each UTC day in [from, to), the last storage.snapshot
   * per project that day, summed across projects. One snapshot/day/project is the
   * normal cadence, but this stays correct if the cadence is ever increased.
   */
  async storageSeries(
    organizationId: string,
    from: Date,
    to: Date
  ): Promise<Array<{ bucket: string; quantity: number }>> {
    const query = sql<{ bucket: string; quantity: number | string }>`
      SELECT bucket, SUM(quantity)::float8 AS quantity FROM (
        SELECT DISTINCT ON (project_id, date_trunc('day', time AT TIME ZONE 'UTC'))
          to_char(date_trunc('day', time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
          quantity
        FROM metering_events
        WHERE organization_id = ${organizationId}
          AND type = 'storage.snapshot'
          AND time >= ${from} AND time < ${to}
        ORDER BY project_id, date_trunc('day', time AT TIME ZONE 'UTC'), time DESC
      ) t
      GROUP BY bucket
      ORDER BY bucket`;
    const result = await query.execute(db);
    return result.rows.map((r) => ({
      bucket: r.bucket,
      quantity: typeof r.quantity === 'number' ? r.quantity : parseFloat(r.quantity),
    }));
  }

  async aggregate(params: UsageAggregateParams): Promise<UsageRow[]> {
    const { organizationId, from, to, groupBy, type } = params;
    const typeFilter = type ? sql`AND type = ${type}` : sql``;

    let query;
    if (groupBy === 'project') {
      query = sql<RawRow>`
        SELECT project_id, type, SUM(quantity)::float8 AS quantity
        FROM metering_events
        WHERE organization_id = ${organizationId}
          AND time >= ${from} AND time < ${to} ${typeFilter}
        GROUP BY project_id, type
        ORDER BY project_id, type`;
    } else if (groupBy === 'day') {
      // UTC calendar-day buckets, independent of the DB session timezone.
      // `time AT TIME ZONE 'UTC'` yields the UTC wall-clock; to_char gives a stable string.
      query = sql<RawRow>`
        SELECT to_char(date_trunc('day', time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
               type, SUM(quantity)::float8 AS quantity
        FROM metering_events
        WHERE organization_id = ${organizationId}
          AND time >= ${from} AND time < ${to} ${typeFilter}
        GROUP BY bucket, type
        ORDER BY bucket, type`;
    } else {
      query = sql<RawRow>`
        SELECT type, SUM(quantity)::float8 AS quantity
        FROM metering_events
        WHERE organization_id = ${organizationId}
          AND time >= ${from} AND time < ${to} ${typeFilter}
        GROUP BY type
        ORDER BY type`;
    }

    const result = await query.execute(db);
    return result.rows.map((r) => ({
      type: r.type,
      project_id: r.project_id ?? null,
      bucket: r.bucket instanceof Date ? r.bucket.toISOString() : (r.bucket as string | undefined),
      quantity: typeof r.quantity === 'number' ? r.quantity : parseFloat(r.quantity),
    }));
  }
}

export const meteringService = new MeteringService();
