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
