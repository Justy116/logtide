-- ============================================================================
-- Migration 037: Monitor Notification Channels
-- Adds dedicated notification channel for monitoring (separate from SIEM)
-- ============================================================================

-- Junction table: Monitors <-> Notification Channels (many-to-many)
CREATE TABLE IF NOT EXISTS monitor_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(monitor_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_monitor_channels_monitor ON monitor_channels(monitor_id);
CREATE INDEX IF NOT EXISTS idx_monitor_channels_channel ON monitor_channels(channel_id);

-- Update organization_default_channels constraint to include 'monitoring'
ALTER TABLE organization_default_channels DROP CONSTRAINT IF EXISTS organization_default_channels_event_type_check;
ALTER TABLE organization_default_channels ADD CONSTRAINT organization_default_channels_event_type_check
  CHECK (event_type IN ('incident', 'error', 'sigma', 'alert', 'monitoring'));
