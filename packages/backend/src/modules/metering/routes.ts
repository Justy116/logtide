import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/middleware.js';
import { OrganizationsService } from '../organizations/service.js';
import { meteringService } from './service.js';
import type { MeteringEventType } from './types.js';

const organizationsService = new OrganizationsService();

const usageQuerySchema = z.object({
  organizationId: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  groupBy: z.enum(['type', 'project', 'day']).default('type'),
  type: z.string().optional(),
});

async function checkMembership(userId: string, orgId: string): Promise<boolean> {
  const orgs = await organizationsService.getUserOrganizations(userId);
  return orgs.some((o) => o.id === orgId);
}

export async function usageRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', authenticate);

  fastify.get('/', async (request: any, reply) => {
    try {
      const q = usageQuerySchema.parse(request.query);
      if (!(await checkMembership(request.user.id, q.organizationId))) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const usage = await meteringService.aggregate({
        organizationId: q.organizationId,
        from: new Date(q.from),
        to: new Date(q.to),
        groupBy: q.groupBy,
        type: q.type as MeteringEventType | undefined,
      });

      return reply.send({ usage });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: e.errors });
      }
      throw e;
    }
  });
}
