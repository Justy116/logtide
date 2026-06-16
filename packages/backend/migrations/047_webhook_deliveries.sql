-- migrations/047_webhook_deliveries.sql
-- Generic outbound webhook delivery infrastructure (#218).
-- One logical delivery per enqueue; one row per HTTP attempt. DLQ = status='dead'.

CREATE TABLE webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  event_type      TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  url             TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempt_count   INT  NOT NULL DEFAULT 0,
  max_attempts    INT  NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_org_created ON webhook_deliveries(organization_id, created_at DESC);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status);

CREATE TABLE webhook_delivery_attempts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id      UUID NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number   INT NOT NULL,
  status_code      INT,
  duration_ms      INT,
  response_excerpt TEXT,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_delivery_attempts_delivery ON webhook_delivery_attempts(delivery_id, created_at DESC);
