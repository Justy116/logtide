import type { FastifyPluginAsync } from 'fastify';
import { tracesService } from './service.js';
import { requireFullAccess, resolveQueryProjectId } from '../auth/guards.js';
import { verifyProjectAccess } from '../auth/verify-project-access.js';

const tracesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/traces', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          // projectId and service accept CSV strings to stay compatible with
          // the existing query-string parser; we split on commas server-side.
          projectId: { type: 'string' },
          service: { type: 'string' },
          error: { type: 'boolean' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          minDurationMs: { type: 'number', minimum: 0 },
          maxDurationMs: { type: 'number', minimum: 0 },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 50 },
          offset: { type: 'number', minimum: 0, default: 0 },
        },
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const {
        projectId: queryProjectId,
        service,
        error,
        from,
        to,
        minDurationMs,
        maxDurationMs,
        limit,
        offset,
      } = request.query as {
        projectId?: string;
        service?: string;
        error?: boolean;
        from?: string;
        to?: string;
        minDurationMs?: number;
        maxDurationMs?: number;
        limit?: number;
        offset?: number;
      };

      // Resolve projectId enforcing API-key tenant boundary
      const resolvedProjectIdRaw = await resolveQueryProjectId(request, reply, queryProjectId);
      if (resolvedProjectIdRaw === null) return; // 403 already sent
      const projectIdsRaw = resolvedProjectIdRaw;

      if (!projectIdsRaw) {
        return reply.code(400).send({
          error: 'Project context missing - provide projectId query parameter',
        });
      }

      const projectIds: string[] = Array.isArray(projectIdsRaw)
        ? (projectIdsRaw as string[])
        : String(projectIdsRaw).split(',').map((s: string) => s.trim()).filter(Boolean);

      if (request.user?.id) {
        for (const pid of projectIds) {
          const hasAccess = await verifyProjectAccess(pid, request.user.id);
          if (!hasAccess) {
            return reply.code(403).send({
              error: 'Access denied - you do not have access to this project',
            });
          }
        }
      }

      const services = service
        ? service.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

      const result = await tracesService.listTraces({
        projectId: projectIds.length === 1 ? projectIds[0] : projectIds,
        service: services && services.length > 0 ? (services.length === 1 ? services[0] : services) : undefined,
        error,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        minDurationMs,
        maxDurationMs,
        limit: limit || 50,
        offset: offset || 0,
      });

      return result;
    },
  });

  // Live tail stream (SSE) - must be registered before :traceId wildcard
  fastify.get('/api/v1/traces/stream', {
    schema: {
      description: 'Live tail traces via Server-Sent Events',
      tags: ['traces'],
      querystring: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          service: { type: 'string' }, // CSV of service names
          error: { type: 'boolean' },
        },
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { projectId: queryProjectId, service, error } = request.query as {
        projectId?: string;
        service?: string;
        error?: boolean;
      };

      // Resolve projectId enforcing API-key tenant boundary
      const resolvedStreamProjectId = await resolveQueryProjectId(request, reply, queryProjectId);
      if (resolvedStreamProjectId === null) return; // 403 already sent
      const projectId = resolvedStreamProjectId as string | undefined;

      if (!projectId) {
        return reply.code(400).send({
          error: 'Project context missing - provide projectId query parameter',
        });
      }

      if (request.user?.id) {
        const hasAccess = await verifyProjectAccess(projectId, request.user.id);
        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you do not have access to this project',
          });
        }
      }

      const services = service
        ? service.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;

      reply.raw.setHeader('Access-Control-Allow-Origin', '*');
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'false');
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      let lastTimestamp = new Date();
      let sentIds = new Set<string>();

      reply.raw.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date() })}\n\n`);

      const intervalId = setInterval(async () => {
        try {
          const result = await tracesService.listTraces({
            projectId,
            service: services && services.length > 0 ? (services.length === 1 ? services[0] : services) : undefined,
            error,
            from: lastTimestamp,
            to: new Date(),
            limit: 100,
            offset: 0,
          });

          if (result.traces.length > 0) {
            const fresh = result.traces.filter((t) => !sentIds.has(t.trace_id));
            if (fresh.length > 0) {
              let maxTimeMs = lastTimestamp.getTime();
              for (const t of result.traces) {
                const tMs = new Date(t.start_time).getTime();
                if (tMs > maxTimeMs) maxTimeMs = tMs;
              }
              lastTimestamp = new Date(maxTimeMs);

              // Rebuild sentIds with just the latest-bucket trace_ids to bound memory.
              sentIds = new Set<string>();
              for (const t of result.traces) {
                if (new Date(t.start_time).getTime() === maxTimeMs) {
                  sentIds.add(t.trace_id);
                }
              }

              for (const t of fresh) {
                reply.raw.write(`data: ${JSON.stringify({ type: 'trace', data: t })}\n\n`);
              }
            }
          }

          reply.raw.write(`: heartbeat\n\n`);
        } catch (e) {
          console.error('Error in traces SSE stream:', e);
          clearInterval(intervalId);
          reply.raw.end();
        }
      }, 1000);

      request.raw.on('close', () => {
        clearInterval(intervalId);
      });
    },
  });

  // Static routes MUST be registered before :traceId wildcard
  fastify.get('/api/v1/traces/services', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
        },
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { projectId: queryProjectId } = request.query as { projectId?: string };

      // Resolve projectId enforcing API-key tenant boundary
      const resolvedServicesProjectId = await resolveQueryProjectId(request, reply, queryProjectId);
      if (resolvedServicesProjectId === null) return; // 403 already sent
      const projectId = resolvedServicesProjectId as string | undefined;

      if (!projectId) {
        return reply.code(400).send({
          error: 'Project context missing - provide projectId query parameter',
        });
      }

      if (request.user?.id) {
        const hasAccess = await verifyProjectAccess(projectId, request.user.id);
        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you do not have access to this project',
          });
        }
      }

      const services = await tracesService.getServices(projectId);

      return { services };
    },
  });

  fastify.get('/api/v1/traces/dependencies', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
        },
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { projectId: queryProjectId, from, to } = request.query as {
        projectId?: string;
        from?: string;
        to?: string;
      };

      // Resolve projectId enforcing API-key tenant boundary
      const resolvedDepsProjectId = await resolveQueryProjectId(request, reply, queryProjectId);
      if (resolvedDepsProjectId === null) return; // 403 already sent
      const projectId = resolvedDepsProjectId as string | undefined;

      if (!projectId) {
        return reply.code(400).send({
          error: 'Project context missing - provide projectId query parameter',
        });
      }

      if (request.user?.id) {
        const hasAccess = await verifyProjectAccess(projectId, request.user.id);
        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you do not have access to this project',
          });
        }
      }

      const dependencies = await tracesService.getServiceDependencies(
        projectId,
        from ? new Date(from) : undefined,
        to ? new Date(to) : undefined
      );

      return dependencies;
    },
  });

  fastify.get('/api/v1/traces/service-map', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
        },
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { projectId: queryProjectId, from, to } = request.query as {
        projectId?: string;
        from?: string;
        to?: string;
      };

      // Resolve projectId enforcing API-key tenant boundary
      const resolvedSvcMapProjectId = await resolveQueryProjectId(request, reply, queryProjectId);
      if (resolvedSvcMapProjectId === null) return; // 403 already sent
      const projectId = resolvedSvcMapProjectId as string | undefined;

      if (!projectId) {
        return reply.code(400).send({
          error: 'Project context missing - provide projectId query parameter',
        });
      }

      if (request.user?.id) {
        const hasAccess = await verifyProjectAccess(projectId, request.user.id);
        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you do not have access to this project',
          });
        }
      }

      const data = await tracesService.getEnrichedServiceDependencies(
        projectId,
        from ? new Date(from) : undefined,
        to ? new Date(to) : undefined
      );

      return data;
    },
  });

  fastify.get('/api/v1/traces/stats', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
        },
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { projectId: queryProjectId, from, to } = request.query as {
        projectId?: string;
        from?: string;
        to?: string;
      };

      // Resolve projectId enforcing API-key tenant boundary
      const resolvedStatsProjectId = await resolveQueryProjectId(request, reply, queryProjectId);
      if (resolvedStatsProjectId === null) return; // 403 already sent
      const projectId = resolvedStatsProjectId as string | undefined;

      if (!projectId) {
        return reply.code(400).send({
          error: 'Project context missing - provide projectId query parameter',
        });
      }

      if (request.user?.id) {
        const hasAccess = await verifyProjectAccess(projectId, request.user.id);
        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you do not have access to this project',
          });
        }
      }

      const stats = await tracesService.getStats(
        projectId,
        from ? new Date(from) : undefined,
        to ? new Date(to) : undefined
      );

      return stats;
    },
  });

  // Wildcard routes AFTER static routes
  fastify.get('/api/v1/traces/:traceId', {
    schema: {
      params: {
        type: 'object',
        properties: {
          traceId: { type: 'string' },
        },
        required: ['traceId'],
      },
      querystring: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
        },
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { traceId } = request.params as { traceId: string };
      const { projectId: queryProjectId } = request.query as { projectId?: string };

      // Resolve projectId enforcing API-key tenant boundary
      const resolvedTraceProjectId = await resolveQueryProjectId(request, reply, queryProjectId);
      if (resolvedTraceProjectId === null) return; // 403 already sent
      const projectId = resolvedTraceProjectId as string | undefined;

      if (!projectId) {
        return reply.code(400).send({
          error: 'Project context missing - provide projectId query parameter',
        });
      }

      if (request.user?.id) {
        const hasAccess = await verifyProjectAccess(projectId, request.user.id);
        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you do not have access to this project',
          });
        }
      }

      const trace = await tracesService.getTrace(traceId, projectId);

      if (!trace) {
        return reply.code(404).send({
          error: 'Trace not found',
        });
      }

      return trace;
    },
  });

  fastify.get('/api/v1/traces/:traceId/spans', {
    schema: {
      params: {
        type: 'object',
        properties: {
          traceId: { type: 'string' },
        },
        required: ['traceId'],
      },
      querystring: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
        },
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { traceId } = request.params as { traceId: string };
      const { projectId: queryProjectId } = request.query as { projectId?: string };

      // Resolve projectId enforcing API-key tenant boundary
      const resolvedSpansProjectId = await resolveQueryProjectId(request, reply, queryProjectId);
      if (resolvedSpansProjectId === null) return; // 403 already sent
      const projectId = resolvedSpansProjectId as string | undefined;

      if (!projectId) {
        return reply.code(400).send({
          error: 'Project context missing - provide projectId query parameter',
        });
      }

      if (request.user?.id) {
        const hasAccess = await verifyProjectAccess(projectId, request.user.id);
        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you do not have access to this project',
          });
        }
      }

      const spans = await tracesService.getTraceSpans(traceId, projectId);

      return { spans };
    },
  });

};

export default tracesRoutes;
