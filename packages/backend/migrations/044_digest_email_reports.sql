-- ============================================================================
-- Migration 042: Digest Email Reports
-- Adds scheduled email digest configuration and per-recipient unsubscribe support.
-- ============================================================================

-- One digest schedule per organization (daily or weekly).
-- delivery_day_of_week required when frequency = 'weekly' (0 = Sunday).

CREATE TABLE IF NOT EXISTS digest_configs (
  id                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  organization_id       UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  frequency             TEXT         NOT NULL,
  delivery_hour         INTEGER      NOT NULL,
  delivery_day_of_week  INTEGER,
  enabled               BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  CONSTRAINT digest_configs_frequency_check
    CHECK (frequency IN ('daily', 'weekly')),
  CONSTRAINT digest_configs_delivery_hour_check
    CHECK (delivery_hour >= 0 AND delivery_hour <= 23),
  CONSTRAINT digest_configs_delivery_day_check
    CHECK (delivery_day_of_week IS NULL OR (delivery_day_of_week >= 0 AND delivery_day_of_week <= 6)),
  CONSTRAINT digest_configs_weekly_requires_day
    CHECK (frequency != 'weekly' OR delivery_day_of_week IS NOT NULL),
  UNIQUE (organization_id)
);

-- Per-recipient subscription state for a digest config.
-- user_id nullable - internal recipients link to a users row (auto-nulled on account deletion),external recipients have no account and use email only.
-- unsubscribe_token is 32 random bytes (URL-safe base64).

CREATE TABLE IF NOT EXISTS digest_recipients (
  id                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  organization_id     UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  digest_config_id    UUID         NOT NULL REFERENCES digest_configs(id) ON DELETE CASCADE,
  user_id             UUID         REFERENCES users(id) ON DELETE SET NULL,
  email               TEXT         NOT NULL,
  subscribed          BOOLEAN      NOT NULL DEFAULT TRUE,
  unsubscribe_token   TEXT         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  UNIQUE (unsubscribe_token),
  UNIQUE (organization_id, email)
);


-- For fast lookup of all recipients for a given config (used when sending)
CREATE INDEX IF NOT EXISTS idx_digest_recipients_config_subscribed
  ON digest_recipients(digest_config_id, subscribed);

-- For fast lookup of all recipients for a given org (used by management API)
CREATE INDEX IF NOT EXISTS idx_digest_recipients_org
  ON digest_recipients(organization_id);