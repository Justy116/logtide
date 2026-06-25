import type { FastifyPluginAsync } from 'fastify';
import { dashboardService } from './service.js';
import { db } from '../../database/index.js';
import { requireFullAccess } from '../auth/guards.js';
import { fetchPanelData } from '../custom-dashboards/panel-data-service.js';
import type { ActivityOverviewConfig, ActivityOverviewSeries } from '@logtide/shared';

const ACTIVITY_OVERVIEW_SERIES: ActivityOverviewSeries[] = [
  'logs',
  'log_errors',
  'spans',
  'span_errors',
  'detections',
  'alerts',
];


async function verifyOrganizationAccess(organizationId: string, userId: string): Promise<boolean> {
  const result = await db
    .selectFrom('organization_members')
    .select(['organization_id'])
    .where('organization_id', '=', organizationId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  return !!result;
}

async function verifyProjectBelongsToOrg(projectId: string, organizationId: string): Promise<boolean> {
  const result = await db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', projectId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();

  return !!result;
}

const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/dashboard/stats - Get dashboard statistics
  fastify.get('/api/v1/dashboard/stats', {
    schema: {
      description: 'Get dashboard statistics for organization or project',
      tags: ['dashboard'],
      querystring: {
        type: 'object',
        properties: {
          organizationId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
        },
        required: ['organizationId'],
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { organizationId, projectId } = request.query as { organizationId: string; projectId?: string };

      if (!organizationId) {
        return reply.code(400).send({
          error: 'organizationId is required',
        });
      }

      // SECURITY: Verify user is member of this organization (if using session auth)
      if (request.user?.id) {
        const hasAccess = await verifyOrganizationAccess(organizationId, request.user.id);

        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you are not a member of this organization',
          });
        }
      }

      // Verify project belongs to org if specified
      if (projectId) {
        const belongsToOrg = await verifyProjectBelongsToOrg(projectId, organizationId);
        if (!belongsToOrg) {
          return reply.code(404).send({ error: 'Project not found in this organization' });
        }
      }

      const stats = await dashboardService.getStats(organizationId, projectId);
      return stats;
    },
  });

  // GET /api/v1/dashboard/timeseries - Get timeseries data for chart
  fastify.get('/api/v1/dashboard/timeseries', {
    schema: {
      description: 'Get timeseries data for dashboard chart (last 24 hours)',
      tags: ['dashboard'],
      querystring: {
        type: 'object',
        properties: {
          organizationId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
        },
        required: ['organizationId'],
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { organizationId, projectId } = request.query as { organizationId: string; projectId?: string };

      if (!organizationId) {
        return reply.code(400).send({
          error: 'organizationId is required',
        });
      }

      // SECURITY: Verify user is member of this organization (if using session auth)
      if (request.user?.id) {
        const hasAccess = await verifyOrganizationAccess(organizationId, request.user.id);

        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you are not a member of this organization',
          });
        }
      }

      if (projectId) {
        const belongsToOrg = await verifyProjectBelongsToOrg(projectId, organizationId);
        if (!belongsToOrg) {
          return reply.code(404).send({ error: 'Project not found in this organization' });
        }
      }

      const timeseries = await dashboardService.getTimeseries(organizationId, projectId);
      return { timeseries };
    },
  });

  // GET /api/v1/dashboard/activity-overview - Multi-signal activity timeline
  // (logs, spans, detections, alerts). Reuses the custom-dashboard panel fetcher.
  fastify.get('/api/v1/dashboard/activity-overview', {
    schema: {
      description: 'Get multi-signal activity overview timeline for organization or project',
      tags: ['dashboard'],
      querystring: {
        type: 'object',
        properties: {
          organizationId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          timeRange: { type: 'string', enum: ['24h', '7d', '30d'] },
        },
        required: ['organizationId'],
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { organizationId, projectId, timeRange } = request.query as {
        organizationId: string;
        projectId?: string;
        timeRange?: '24h' | '7d' | '30d';
      };

      if (!organizationId) {
        return reply.code(400).send({ error: 'organizationId is required' });
      }

      if (request.user?.id) {
        const hasAccess = await verifyOrganizationAccess(organizationId, request.user.id);
        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you are not a member of this organization',
          });
        }
      }

      if (projectId) {
        const belongsToOrg = await verifyProjectBelongsToOrg(projectId, organizationId);
        if (!belongsToOrg) {
          return reply.code(404).send({ error: 'Project not found in this organization' });
        }
      }

      const config: ActivityOverviewConfig = {
        type: 'activity_overview',
        title: 'Activity Overview',
        source: 'mixed',
        projectId: projectId ?? null,
        timeRange: timeRange ?? '24h',
        series: ACTIVITY_OVERVIEW_SERIES,
      };

      const data = await fetchPanelData(config, {
        organizationId,
        userId: request.user?.id ?? '',
      });
      return data;
    },
  });

  // GET /api/v1/dashboard/top-services - Get top services
  fastify.get('/api/v1/dashboard/top-services', {
    schema: {
      description: 'Get top services by log count for organization or project',
      tags: ['dashboard'],
      querystring: {
        type: 'object',
        properties: {
          organizationId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          limit: { type: 'number', minimum: 1, maximum: 20, default: 5 },
        },
        required: ['organizationId'],
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { organizationId, projectId, limit } = request.query as { organizationId: string; projectId?: string; limit?: number };

      if (!organizationId) {
        return reply.code(400).send({
          error: 'organizationId is required',
        });
      }

      // SECURITY: Verify user is member of this organization (if using session auth)
      if (request.user?.id) {
        const hasAccess = await verifyOrganizationAccess(organizationId, request.user.id);

        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you are not a member of this organization',
          });
        }
      }

      if (projectId) {
        const belongsToOrg = await verifyProjectBelongsToOrg(projectId, organizationId);
        if (!belongsToOrg) {
          return reply.code(404).send({ error: 'Project not found in this organization' });
        }
      }

      const services = await dashboardService.getTopServices(organizationId, limit || 5, projectId);
      return { services };
    },
  });

  // GET /api/v1/dashboard/timeline-events - Get alert/detection events for chart markers
  fastify.get('/api/v1/dashboard/timeline-events', {
    schema: {
      description: 'Get timeline events (alerts + detections) for last 24 hours',
      tags: ['dashboard'],
      querystring: {
        type: 'object',
        properties: {
          organizationId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
        },
        required: ['organizationId'],
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { organizationId, projectId } = request.query as { organizationId: string; projectId?: string };

      if (!organizationId) {
        return reply.code(400).send({
          error: 'organizationId is required',
        });
      }

      if (request.user?.id) {
        const hasAccess = await verifyOrganizationAccess(organizationId, request.user.id);

        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you are not a member of this organization',
          });
        }
      }

      if (projectId) {
        const belongsToOrg = await verifyProjectBelongsToOrg(projectId, organizationId);
        if (!belongsToOrg) {
          return reply.code(404).send({ error: 'Project not found in this organization' });
        }
      }

      const events = await dashboardService.getTimelineEvents(organizationId, projectId);
      return { events };
    },
  });

  // GET /api/v1/dashboard/recent-errors - Get recent errors
  fastify.get('/api/v1/dashboard/recent-errors', {
    schema: {
      description: 'Get recent error logs for organization or project',
      tags: ['dashboard'],
      querystring: {
        type: 'object',
        properties: {
          organizationId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
        },
        required: ['organizationId'],
      },
    },
    handler: async (request: any, reply) => {
      if (!await requireFullAccess(request, reply)) return;

      const { organizationId, projectId } = request.query as { organizationId: string; projectId?: string };

      if (!organizationId) {
        return reply.code(400).send({
          error: 'organizationId is required',
        });
      }

      // SECURITY: Verify user is member of this organization (if using session auth)
      if (request.user?.id) {
        const hasAccess = await verifyOrganizationAccess(organizationId, request.user.id);

        if (!hasAccess) {
          return reply.code(403).send({
            error: 'Access denied - you are not a member of this organization',
          });
        }
      }

      if (projectId) {
        const belongsToOrg = await verifyProjectBelongsToOrg(projectId, organizationId);
        if (!belongsToOrg) {
          return reply.code(404).send({ error: 'Project not found in this organization' });
        }
      }

      const errors = await dashboardService.getRecentErrors(organizationId, projectId);
      return { errors };
    },
  });
};

export default dashboardRoutes;
