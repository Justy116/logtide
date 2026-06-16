-- Resource usage metering events (#212)
-- Control-plane hypertable. One row per recorder flush entry (per ingestion batch, etc.).
-- Low volume relative to logs: aggregation is done at query time (no continuous aggregates).

CREATE TABLE IF NOT EXISTS metering_events (
  time            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  organization_id UUID NOT NULL,
  project_id      UUID,
  type            TEXT NOT NULL,
  quantity        DOUBLE PRECISION NOT NULL,
  metadata        JSONB
);

-- TimescaleDB hypertable on time (create_hypertable is transaction-safe, unlike continuous aggregates).
SELECT create_hypertable('metering_events', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_metering_org_type_time
  ON metering_events (organization_id, type, time DESC);

CREATE INDEX IF NOT EXISTS idx_metering_org_project_time
  ON metering_events (organization_id, project_id, time DESC);
