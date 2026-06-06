import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/middleware.js';
import { OrganizationsService } from '../organizations/service.js';
import { meteringService } from './service.js';
import { getUsageBreakdown } from './breakdown.js';
import type { MeteringEventType } from './types.js';

const organizationsService = new OrganizationsService();

const usageQuerySchema = z.object({
  organizationId: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  groupBy: z.enum(['type', 'project', 'day']).default('type'),
  type: z.string().optional(),
});

const breakdownQuerySchema = z.object({
  organizationId: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
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

  // "What is being ingested" breakdown: by metering type, by project (with name),
  // by service and by level (logs composition).
  fastify.get('/breakdown', async (request: any, reply) => {
    try {
      const q = breakdownQuerySchema.parse(request.query);
      if (!(await checkMembership(request.user.id, q.organizationId))) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const breakdown = await getUsageBreakdown({
        organizationId: q.organizationId,
        from: new Date(q.from),
        to: new Date(q.to),
      });

      return reply.send({ breakdown });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: e.errors });
      }
      throw e;
    }
  });

  // Storage estimate: current value (latest snapshot, summed across projects)
  // plus the daily trend. storage.snapshot is a gauge - it is read with
  // last-per-day semantics, never summed over time.
  fastify.get('/storage', async (request: any, reply) => {
    try {
      const q = breakdownQuerySchema.parse(request.query);
      if (!(await checkMembership(request.user.id, q.organizationId))) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      // current is the all-time latest gauge (not bounded by from/to); stale values decay to 0 via the snapshot job's zero-decay pass.
      const [current, series] = await Promise.all([
        meteringService.latestPointInTime(q.organizationId, 'storage.snapshot'),
        meteringService.storageSeries(q.organizationId, new Date(q.from), new Date(q.to)),
      ]);

      return reply.send({ current, series });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: e.errors });
      }
      throw e;
    }
  });
}
