import { getApiBaseUrl } from '$lib/config';

/**
 * Mint a short-lived, single-use stream ticket for the current session.
 *
 * Browser WebSocket and EventSource APIs cannot set an Authorization header, so
 * stream URLs historically carried the session token in the query string, where
 * reverse proxies and servers log it. Instead, callers fetch a ticket via this
 * authenticated request and pass the ticket (not the token) in the stream URL.
 */
export async function requestStreamTicket(token: string | null): Promise<string> {
  const response = await fetch(`${getApiBaseUrl()}/stream-tickets`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    throw new Error(`Failed to obtain stream ticket: ${response.status}`);
  }

  const data = await response.json().catch(() => ({}));
  if (!data.ticket) {
    throw new Error('Stream ticket response did not include a ticket');
  }
  return data.ticket as string;
}
