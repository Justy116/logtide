-- ============================================================================
-- Migration 043: Error notification throttling
-- Adds last_notified_at on error_groups so the error-notification job can
-- throttle alerts per group. Before this, every single exception occurrence
-- sent an email/notification, so a high-frequency error (e.g. a frontend
-- effect loop firing thousands of times) produced thousands of identical
-- emails.
--
-- The notification job now atomically claims a notification slot:
--   UPDATE ... SET last_notified_at = now()
--   WHERE status != 'ignored'
--     AND (last_notified_at IS NULL OR last_notified_at <= now() - cooldown)
-- so only one occurrence per cooldown window actually notifies.
-- ============================================================================

ALTER TABLE error_groups
  ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;
