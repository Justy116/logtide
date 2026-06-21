import { randomBytes } from 'crypto';
import { db } from '../../database/index.js';

/**
 * Short-lived, single-use tickets for browser streaming endpoints.
 *
 * Browser WebSocket and EventSource APIs cannot set request headers, so they
 * cannot send the session token as `Authorization: Bearer`. Putting the
 * long-lived session token in the URL query string leaks it into reverse-proxy
 * and server access logs. Instead the client makes an authenticated request to
 * mint a ticket and passes the ticket (not the session token) in the stream URL.
 *
 * Tickets are stored in the relational database (not Redis) so the mechanism
 * works regardless of the configured queue backend (BullMQ or graphile-worker).
 */

// Tickets are meant to be redeemed immediately after minting; keep the window short.
const TICKET_TTL_MS = 30_000;

export const streamTicketService = {
  /**
   * Create a single-use ticket bound to the given user. Best-effort prunes
   * expired tickets so the table stays small.
   */
  async createTicket(userId: string): Promise<{ ticket: string; expiresInSeconds: number }> {
    const ticket = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TICKET_TTL_MS);

    await db
      .insertInto('stream_tickets')
      .values({ ticket, user_id: userId, expires_at: expiresAt })
      .execute();

    // Best-effort cleanup of expired tickets (ignore failures).
    try {
      await db.deleteFrom('stream_tickets').where('expires_at', '<', new Date()).execute();
    } catch {
      // non-fatal
    }

    return { ticket, expiresInSeconds: Math.floor(TICKET_TTL_MS / 1000) };
  },

  /**
   * Atomically consume a ticket. Returns the bound userId if the ticket exists
   * and has not expired, otherwise null. The ticket is deleted whether or not it
   * was valid for that value, so it can never be redeemed twice.
   */
  async consumeTicket(ticket: string): Promise<string | null> {
    if (!ticket) return null;

    const row = await db
      .deleteFrom('stream_tickets')
      .where('ticket', '=', ticket)
      .returning(['user_id', 'expires_at'])
      .executeTakeFirst();

    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) return null;
    return row.user_id;
  },
};
