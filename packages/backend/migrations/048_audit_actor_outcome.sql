-- migrations/048_audit_actor_outcome.sql
-- Issue #217: typed audit primitive. Additive only: audit_log is a
-- compressed hypertable, legacy rows are normalized at read time.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_type TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_id UUID;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS outcome TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_actor_type_check'
  ) THEN
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check
      CHECK (actor_type IS NULL OR actor_type IN ('user', 'apiKey', 'system'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_outcome_check'
  ) THEN
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_outcome_check
      CHECK (outcome IS NULL OR outcome IN ('success', 'failure'));
  END IF;
END $$;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS audit_retention_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_audit_retention_days_check'
  ) THEN
    ALTER TABLE organizations ADD CONSTRAINT organizations_audit_retention_days_check
      CHECK (audit_retention_days IS NULL OR (audit_retention_days >= 1 AND audit_retention_days <= 3650));
  END IF;
END $$;

-- Migration 025 added a platform-wide 365-day Timescale retention policy on
-- audit_log. That contradicts per-org audit retention (NULL = keep forever):
-- the per-org daily cleanup is now the only deletion path.
SELECT remove_retention_policy('audit_log', if_exists => TRUE);
