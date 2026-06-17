/**
 * Correlation API Routes
 *
 * Endpoints for event correlation feature:
 * - GET /v1/correlation/:identifierValue - Get correlated logs by identifier
 * - GET /v1/logs/:logId/identifiers - Get identifiers for a specific log
 * - POST /v1/logs/identifiers/batch - Get identifiers for multiple logs
 *
 * Security: All routes require authentication via authPlugin (global).
 * Rate limiting: Configured via @fastify/rate-limit plugin with per-route overrides.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { correlationService } from './service.js';
import { db } from '../../database/index.js';
import { reservoir } from '../../database/reservoir.js';
import { requireFullAccess } from '../auth/guards.js';

/**
 * Verify that the request is authenticated.
 * Authentication is handled by the global authPlugin, but this explicit check
 * ensures routes reject unauthenticated requests and satisfies static analysis.
 */
function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authenticated && !request.user) {
    reply.status(401).send({
      success: false,
      error: 'Authentication required',
    });
    return false;
  }
  return true;
}

// Request type declarations
interface CorrelationParams {
  identifierValue: string;
}

interface CorrelationQuery {
  projectId: string;
  referenceTime?: string;
  timeWindowMinutes?: number;
  limit?: number;
}

interface LogIdParams {
  logId: string;
}

interface BatchIdentifiersBody {
  logIds: string[];
}

/**
 * Get all project IDs accessible to the requesting user
 */
async function getUserProjectIds(
  request: { projectId?: string; user?: { id: string } },
): Promise<string[]> {
  // API key auth: single project
  if (request.projectId) return [request.projectId];

  // Session auth: all projects in user's orgs
  if (request.user?.id) {
    const projects = await db
      .selectFrom('projects')
      .innerJoin('organization_members', 'projects.organization_id', 'organization_members.organization_id')
      .select('projects.id')
      .where('organization_members.user_id', '=', request.user.id)
      .execute();
    return projects.map((p) => p.id);
  }

  return [];
}

/**
 * Verify that the requesting user has access to the project
 * For API key auth: projectId is already validated by auth plugin
 * For session auth: verify org membership via user_id
 */
async function verifyProjectAccess(
  request: { projectId?: string; user?: { id: string } },
  projectId: string
): Promise<boolean> {
  // If request already has projectId from API key auth, it's pre-validated
  if (request.projectId === projectId) {
    return true;
  }

  // For session-based auth, verify the user is a member of the project's org
  if (request.user?.id) {
    const result = await db
      .selectFrom('projects')
      .innerJoin('organization_members', 'projects.organization_id', 'organization_members.organization_id')
      .select(['projects.id'])
      .where('projects.id', '=', projectId)
      .where('organization_members.user_id', '=', request.user.id)
      .executeTakeFirst();

    return !!result;
  }

  return false;
}

export default async function correlationRoutes(fastify: FastifyInstance) {
  // Get correlated logs by identifier value
  fastify.get<{
    Params: CorrelationParams;
    Querystring: CorrelationQuery;
  }>(
    '/v1/correlation/:identifierValue',
    {
      config: {
        rateLimit: {
          max: 100,
          timeWindow: '1 minute',
        },
      },
      schema: {
        params: {
          type: 'object',
          required: ['identifierValue'],
          properties: {
            identifierValue: { type: 'string', minLength: 1 },
          },
        },
        querystring: {
          type: 'object',
          required: ['projectId'],
          properties: {
            projectId: { type: 'string' },
            referenceTime: { type: 'string', format: 'date-time' },
            timeWindowMinutes: { type: 'number', default: 15 },
            limit: { type: 'number', default: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      // Explicit auth check (authPlugin handles auth, this ensures static analysis sees it)
      if (!requireAuth(request, reply)) return;
      if (!await requireFullAccess(request, reply)) return;

      const { identifierValue } = request.params;
      const { projectId, referenceTime, timeWindowMinutes, limit } = request.query;

      // Verify project access
      const hasAccess = await verifyProjectAccess(request as any, projectId);
      if (!hasAccess) {
        return reply.status(403).send({
          success: false,
          error: 'Access denied to this project',
        });
      }

      let parsedReferenceTime: Date | undefined;
      if (referenceTime) {
        const d = new Date(referenceTime);
        if (isNaN(d.getTime())) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid referenceTime: must be an ISO 8601 date-time string',
          });
        }
        parsedReferenceTime = d;
      }

      try {
        const result = await correlationService.findCorrelatedLogs({
          projectId,
          identifierValue: decodeURIComponent(identifierValue),
          referenceTime: parsedReferenceTime,
          timeWindowMinutes: timeWindowMinutes ?? 15,
          limit: Math.min(limit ?? 100, 100), // Cap at 100
        });

        return reply.send({
          success: true,
          data: result,
        });
      } catch (error) {
        console.error('[Correlation] Error finding correlated logs:', error);
        return reply.status(500).send({
          success: false,
          error: 'Failed to find correlated logs',
        });
      }
    }
  );

  // Get identifiers for a specific log
  fastify.get<{
    Params: LogIdParams;
    Querystring: { projectId?: string };
  }>(
    '/v1/logs/:logId/identifiers',
    {
      config: {
        rateLimit: {
          max: 100,
          timeWindow: '1 minute',
        },
      },
      schema: {
        params: {
          type: 'object',
          required: ['logId'],
          properties: {
            logId: { type: 'string' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      // Explicit auth check (authPlugin handles auth, this ensures static analysis sees it)
      if (!requireAuth(request, reply)) return;
      if (!await requireFullAccess(request, reply)) return;

      const { logId } = request.params;
      const { projectId } = request.query;

      try {
        // Get the log to verify access (reservoir: works with any engine)
        // Try provided projectId first, then search across user's accessible projects
        let log = projectId
          ? await reservoir.getById({ id: logId, projectId })
          : null;

        if (!log) {
          const userProjectIds = await getUserProjectIds(request as any);
          for (const pid of userProjectIds) {
            log = await reservoir.getById({ id: logId, projectId: pid });
            if (log) break;
          }
        }

        if (!log) {
          return reply.status(404).send({
            success: false,
            error: 'Log not found',
          });
        }

        // Verify project access
        const hasAccess = await verifyProjectAccess(request as any, log.projectId || projectId || '');
        if (!hasAccess) {
          return reply.status(403).send({
            success: false,
            error: 'Access denied to this log',
          });
        }

        const identifiers = await correlationService.getLogIdentifiers(logId, log.projectId || projectId || '');

        return reply.send({
          success: true,
          data: { identifiers },
        });
      } catch (error) {
        console.error('[Correlation] Error getting log identifiers:', error);
        return reply.status(500).send({
          success: false,
          error: 'Failed to get log identifiers',
        });
      }
    }
  );

  // Get identifiers for multiple logs (batch)
  fastify.post<{
    Body: BatchIdentifiersBody;
    Querystring: { projectId?: string };
  }>(
    '/v1/logs/identifiers/batch',
    {
      config: {
        rateLimit: {
          max: 50,
          timeWindow: '1 minute',
        },
      },
      schema: {
        body: {
          type: 'object',
          required: ['logIds'],
          properties: {
            logIds: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 100,
            },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      // Explicit auth check (authPlugin handles auth, this ensures static analysis sees it)
      if (!requireAuth(request, reply)) return;
      // This reads log data, so require full (read) access like the sibling read
      // endpoints; a write-only API key must not be able to read identifiers.
      if (!await requireFullAccess(request, reply)) return;

      const { logIds } = request.body;
      const { projectId } = request.query;

      // Server-side validation of batch size
      if (logIds.length > 100) {
        return reply.status(400).send({
          success: false,
          error: 'Batch size exceeds maximum of 100 log IDs',
        });
      }

      if (logIds.length === 0) {
        return reply.send({
          success: true,
          data: { identifiers: {} },
        });
      }

      try {
        // Determine which projects to search for these logs. A caller-supplied
        // projectId must be intersected with the projects the user/API key can
        // actually access, otherwise any authenticated caller could read another
        // tenant's log identifiers by passing a foreign projectId.
        const accessibleProjectIds = await getUserProjectIds(request as any);
        const searchProjectIds = projectId
          ? accessibleProjectIds.filter((id) => id === projectId)
          : accessibleProjectIds;

        if (searchProjectIds.length === 0) {
          return reply.status(403).send({
            success: false,
            error: 'Access denied to these logs',
          });
        }

        // Query log_identifiers directly - log_identifiers is always in PostgreSQL and
        // already contains log_id, project_id, and identifier data. No need to hit the
        // storage engine (ClickHouse/TimescaleDB/MongoDB) at all.
        // The project_id IN searchProjectIds clause enforces access control.
        const rows = await db
          .selectFrom('log_identifiers')
          .select(['log_id', 'identifier_type', 'identifier_value', 'source_field'])
          .where('log_id', 'in', logIds)
          .where('project_id', 'in', searchProjectIds)
          .execute();

        const identifiers: Record<string, Array<{ type: string; value: string; sourceField: string }>> = {};
        for (const row of rows) {
          if (!identifiers[row.log_id]) identifiers[row.log_id] = [];
          identifiers[row.log_id].push({
            type: row.identifier_type,
            value: row.identifier_value,
            sourceField: row.source_field,
          });
        }

        return reply.send({
          success: true,
          data: { identifiers },
        });
      } catch (error) {
        console.error('[Correlation] Error getting batch identifiers:', error);
        return reply.status(500).send({
          success: false,
          error: 'Failed to get batch identifiers',
        });
      }
    }
  );
}
