import { QueryTranslator, type NativeQuery } from '../../core/query-translator.js';
import type {
  AggregateParams,
  AggregationInterval,
  CountParams,
  DeleteByTimeRangeParams,
  DistinctParams,
  MetadataFilter,
  QueryParams,
  TopValuesParams,
} from '../../core/types.js';

/** Escape special regex characters in user-provided search strings */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Check if search string contains special characters unsuitable for $text search */
function hasSpecialChars(search: string): boolean {
  return /[^a-zA-Z0-9\s]/.test(search);
}

/** Interval to milliseconds for $dateTrunc fallback */
const INTERVAL_MS: Record<AggregationInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '6h': 21_600_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

export class MongoDBQueryTranslator extends QueryTranslator {
  constructor() {
    super();
  }

  translateQuery(params: QueryParams): NativeQuery {
    this.validatePagination(params.limit, params.offset);

    const filter = this.buildLogFilter(params);
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const sortDir = params.sortOrder === 'asc' ? 1 : -1;
    const sort = { time: sortDir, id: sortDir };

    // Cursor-based pagination
    if (params.cursor) {
      try {
        const decoded = Buffer.from(params.cursor, 'base64').toString('utf-8');
        const commaIdx = decoded.indexOf(',');
        if (commaIdx > 0) {
          const cursorTime = decoded.slice(0, commaIdx);
          const cursorId = decoded.slice(commaIdx + 1);
          const parsedTime = new Date(cursorTime);
          if (cursorId && !isNaN(parsedTime.getTime())) {
            const op = params.sortOrder === 'asc' ? '$gt' : '$lt';
            filter.$or = [
              { time: { [op]: parsedTime } },
              { time: parsedTime, id: { [op]: cursorId } },
            ];
          }
        }
      } catch {
        // invalid cursor - skip
      }
    }

    return {
      query: filter,
      parameters: [],
      metadata: { limit, offset, sort },
    };
  }

  translateAggregate(params: AggregateParams): NativeQuery {
    const filter = this.buildBaseFilter(params);
    const intervalMs = INTERVAL_MS[params.interval];

    return {
      query: filter,
      parameters: [],
      metadata: { intervalMs, interval: params.interval },
    };
  }

  translateCount(params: CountParams): NativeQuery {
    const filter = this.buildLogFilter(params);
    return { query: filter, parameters: [] };
  }

  translateDistinct(params: DistinctParams): NativeQuery {
    this.validateFieldName(params.field);
    this.validatePagination(params.limit);

    const filter = this.buildBaseFilter(params);
    const mongoField = this.resolveMongoField(params.field);

    return {
      query: filter,
      parameters: [],
      metadata: { field: params.field, mongoField, limit: params.limit ?? 1000 },
    };
  }

  translateTopValues(params: TopValuesParams): NativeQuery {
    this.validateFieldName(params.field);
    this.validatePagination(params.limit);

    const filter = this.buildBaseFilter(params);
    const mongoField = this.resolveMongoField(params.field);

    return {
      query: filter,
      parameters: [],
      metadata: { field: params.field, mongoField, limit: params.limit ?? 10 },
    };
  }

  translateDelete(params: DeleteByTimeRangeParams): NativeQuery {
    const filter: Record<string, unknown> = {};

    // projectId
    if (Array.isArray(params.projectId)) {
      this.validateArrayFilter('project_id', params.projectId);
      filter.project_id = { $in: params.projectId };
    } else {
      filter.project_id = params.projectId;
    }

    // Time range: from inclusive, to exclusive (matches ClickHouse pattern)
    filter.time = { $gte: params.from, $lt: params.to };

    if (params.service !== undefined) {
      filter.service = this.toMongoFilter(params.service);
    }
    if (params.level !== undefined) {
      filter.level = this.toMongoFilter(params.level);
    }

    return { query: filter, parameters: [] };
  }

  /**
   * Build a MongoDB filter for log queries (shared by query, count, countEstimate).
   * Includes search and hostname filters.
   */
  private buildLogFilter(params: QueryParams | CountParams): Record<string, unknown> {
    const filter = this.buildBaseFilter(params);

    if ('hostname' in params && params.hostname !== undefined) {
      this.validateArrayFilter('hostname', params.hostname);
      filter['metadata.hostname'] = this.toMongoFilter(params.hostname);
    }

    if ('traceId' in params && params.traceId !== undefined) {
      filter.trace_id = params.traceId;
    }
    if ('sessionId' in params && params.sessionId !== undefined) {
      filter.session_id = params.sessionId;
    }

    if ('search' in params && params.search) {
      const search = params.search;
      const searchMode = 'searchMode' in params ? params.searchMode : undefined;

      if (searchMode === 'substring') {
        // Always regex for explicit substring mode
        filter.message = { $regex: escapeRegex(search), $options: 'i' };
      } else if (hasSpecialChars(search)) {
        // Special chars - regex fallback (same as ClickHouse's positionCaseInsensitive)
        filter.message = { $regex: escapeRegex(search), $options: 'i' };
      } else {
        // Clean search term - use $text index for performance
        filter.$text = { $search: search };
      }
    }

    if ('metadataFilters' in params && params.metadataFilters && params.metadataFilters.length > 0) {
      const clauses = this.buildMetadataClauses(params.metadataFilters);
      if (clauses.length > 0) {
        // Use $and so multiple filters on the same metadata key don't overwrite each other.
        filter.$and = clauses;
      }
    }

    return filter;
  }

  /**
   * Translate metadata filters into MongoDB clauses over the `metadata` subdocument.
   * Each filter becomes its own clause keyed on `metadata.<key>` so that repeated keys
   * are AND'd rather than overwritten.
   */
  private buildMetadataClauses(filters: MetadataFilter[]): Record<string, unknown>[] {
    return filters.map((f) => {
      const field = `metadata.${f.key}`;
      switch (f.op) {
        case 'equals':
          return { [field]: f.value };
        case 'not_equals':
          // Bare $ne already matches missing fields; require $exists when missing must be excluded.
          return { [field]: f.include_missing ? { $ne: f.value } : { $exists: true, $ne: f.value } };
        case 'in':
          return { [field]: { $in: f.values } };
        case 'not_in':
          // Bare $nin already matches missing fields; require $exists when missing must be excluded.
          return { [field]: f.include_missing ? { $nin: f.values } : { $exists: true, $nin: f.values } };
        case 'exists':
          return { [field]: { $exists: true } };
        case 'not_exists':
          return { [field]: { $exists: false } };
        case 'contains':
          return { [field]: { $regex: escapeRegex(f.value ?? ''), $options: 'i' } };
      }
    });
  }

  /**
   * Build base filter with projectId, organizationId, time range, service, level.
   * Shared across query, aggregate, count, distinct, topValues.
   */
  private buildBaseFilter(params: {
    organizationId?: string | string[];
    projectId?: string | string[];
    service?: string | string[];
    level?: string | string[];
    from: Date;
    to: Date;
    fromExclusive?: boolean;
    toExclusive?: boolean;
  }): Record<string, unknown> {
    const filter: Record<string, unknown> = {};

    if (params.projectId !== undefined) {
      filter.project_id = this.toMongoFilter(params.projectId);
    }

    if (params.organizationId !== undefined) {
      filter.organization_id = this.toMongoFilter(params.organizationId);
    }

    // Time range
    const timeFilter: Record<string, Date> = {};
    timeFilter[params.fromExclusive ? '$gt' : '$gte'] = params.from;
    timeFilter[params.toExclusive ? '$lt' : '$lte'] = params.to;
    filter.time = timeFilter;

    if (params.service !== undefined) {
      filter.service = this.toMongoFilter(params.service);
    }
    if (params.level !== undefined) {
      filter.level = this.toMongoFilter(params.level);
    }

    return filter;
  }

  /**
   * Convert a string | string[] value to a MongoDB filter value.
   * Single string → exact match, array → $in.
   */
  private toMongoFilter(value: string | string[]): string | { $in: string[] } {
    if (Array.isArray(value)) {
      this.validateArrayFilter('filter', value);
      return { $in: value };
    }
    return value;
  }

  /** Resolve a field name to its MongoDB document path (dot notation works natively) */
  private resolveMongoField(field: string): string {
    return field;
  }
}

export { INTERVAL_MS };
