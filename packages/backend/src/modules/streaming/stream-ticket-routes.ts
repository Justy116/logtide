import type { FastifyPluginAsync } from 'fastify';
import { settingsService } from '../settings/service.js';
import { bootstrapService } from '../bootstrap/service.js';
import { streamTicketService } from './stream-ticket-service.js';

/**
 * POST /api/v1/stream-tickets
 *
 * Mint a short-lived, single-use ticket for the authenticated user. The client
 * passes the returned ticket (instead of the session token) in WebSocket/SSE
 * stream URLs, so the long-lived session token never appears in a URL.
 *
 * Registered after the auth plugin, so the request is already authenticated via
 * the normal Authorization: Bearer header.
 */
const streamTicketRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/api/v1/stream-tickets',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request: any, reply) => {
      let userId: string | undefined = request.user?.id;

      // Auth-free mode: the auth plugin marks the request authenticated without
      // attaching a user, so fall back to the configured default user.
      if (!userId) {
        const authMode = await settingsService.getAuthMode();
        if (authMode === 'none') {
          const defaultUser = await bootstrapService.getDefaultUser();
          userId = defaultUser?.id;
        }
      }

      if (!userId) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const { ticket, expiresInSeconds } = await streamTicketService.createTicket(userId);
      return reply.send({ ticket, expiresInSeconds });
    }
  );
};

export default streamTicketRoutes;
