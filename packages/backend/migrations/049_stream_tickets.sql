-- migrations/049_stream_tickets.sql
-- Short-lived, single-use tickets for browser streaming endpoints (WebSocket
-- live-tail and SSE). EventSource/WebSocket cannot send Authorization headers,
-- so the browser used to put the long-lived session token in the URL query
-- string, where reverse proxies and servers log it. Instead the client now
-- mints a short-lived ticket via an authenticated request and passes the ticket
-- in the stream URL; it is consumed (deleted) on first use.

CREATE TABLE IF NOT EXISTS stream_tickets (
  ticket TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stream_tickets_expires_at ON stream_tickets (expires_at);
