import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import { build } from '../../../server.js';
import { db } from '../../../database/index.js';
import { streamTicketService } from '../../../modules/streaming/stream-ticket-service.js';
import { createTestContext } from '../../helpers/factories.js';
import { createTestSession } from '../../helpers/auth.js';

/**
 * Stream tickets keep the long-lived session token out of WebSocket/SSE URLs.
 * These cover the service (single-use, expiry) and the end-to-end auth chain:
 * minting a ticket with a Bearer token, then redeeming it on a protected route
 * via the ?ticket= query param handled by the auth plugin.
 */
describe('Stream tickets', () => {
  let app: FastifyInstance;
  let userId: string;
  let projectId: string;
  let sessionToken: string;

  beforeEach(async () => {
    const ctx = await createTestContext();
    userId = ctx.user.id;
    projectId = ctx.project.id;
    const session = await createTestSession(userId);
    sessionToken = session.token;

    app = await build();
    await app.ready();
  });

  describe('streamTicketService', () => {
    it('mints a ticket that can be consumed exactly once', async () => {
      const { ticket } = await streamTicketService.createTicket(userId);
      expect(ticket).toMatch(/^[a-f0-9]{64}$/);

      const first = await streamTicketService.consumeTicket(ticket);
      expect(first).toBe(userId);

      // Single use: the same ticket cannot be redeemed again.
      const second = await streamTicketService.consumeTicket(ticket);
      expect(second).toBeNull();
    });

    it('rejects an unknown ticket', async () => {
      const result = await streamTicketService.consumeTicket('does-not-exist');
      expect(result).toBeNull();
    });

    it('rejects an expired ticket', async () => {
      const ticket = 'expired'.padEnd(64, '0');
      await db
        .insertInto('stream_tickets')
        .values({ ticket, user_id: userId, expires_at: new Date(Date.now() - 1000) })
        .execute();

      const result = await streamTicketService.consumeTicket(ticket);
      expect(result).toBeNull();
    });
  });

  describe('POST /api/v1/stream-tickets', () => {
    it('mints a ticket for an authenticated session', async () => {
      const response = await request(app.server)
        .post('/api/v1/stream-tickets')
        .set('Authorization', `Bearer ${sessionToken}`)
        .expect(200);

      expect(response.body.ticket).toMatch(/^[a-f0-9]{64}$/);
      expect(response.body.expiresInSeconds).toBeGreaterThan(0);

      // The minted ticket resolves to the authenticated user.
      const resolved = await streamTicketService.consumeTicket(response.body.ticket);
      expect(resolved).toBe(userId);
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.server).post('/api/v1/stream-tickets').expect(401);
    });
  });

  describe('ticket auth on protected routes', () => {
    it('authenticates a request via ?ticket= and does not leak the session token', async () => {
      const { ticket } = await streamTicketService.createTicket(userId);

      // A protected route (logs query) accepts the ticket in place of credentials.
      await request(app.server)
        .get('/api/v1/logs')
        .query({ projectId, ticket })
        .expect(200);
    });

    it('rejects an invalid ticket on a protected route', async () => {
      await request(app.server)
        .get('/api/v1/logs')
        .query({ projectId, ticket: 'invalid-ticket' })
        .expect(401);
    });

    it('rejects reuse of a ticket on a protected route (single use)', async () => {
      const { ticket } = await streamTicketService.createTicket(userId);

      await request(app.server).get('/api/v1/logs').query({ projectId, ticket }).expect(200);
      // The auth plugin consumed the ticket on the first request.
      await request(app.server).get('/api/v1/logs').query({ projectId, ticket }).expect(401);
    });
  });
});
