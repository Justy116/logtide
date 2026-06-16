-- Per-organization feature entitlements (#214).
-- Key-value: (organization_id, capability) -> { enabled, limit_value }.
-- A row present overrides the registry default; a row absent falls back to the
-- registry default (permissive in OSS). Quota capabilities reuse limit_value for
-- their numeric cap; signal/window live only in the registry, never here.

CREATE TABLE IF NOT EXISTS organization_entitlements (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  capability      TEXT NOT NULL,
  enabled         BOOLEAN,
  limit_value     INTEGER,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_org_entitlements_org
  ON organization_entitlements (organization_id);
