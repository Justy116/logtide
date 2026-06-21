import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../database/index.js';
import { reservoir } from '../../database/reservoir.js';
import type { LogLevel } from '@logtide/shared';
import {
  notificationManager,
  type LogNotificationEvent,
  type LogSubscriber,
} from '../streaming/index.js';
import { randomUUID } from 'crypto';
import { verifyProjectAccess } from '../auth/verify-project-access.js';

/**
 * WebSocket routes for real-time log streaming.
 *
 * Uses PostgreSQL LISTEN/NOTIFY for real-time notifications.
 * When a notification is received, fetches full logs from database
 * and sends to the WebSocket client after applying filters.
 *
 * Rate limiting note: WebSocket connections are long-lived and authenticated.
 * Connection rate is implicitly limited by authentication requirements.
 */
const websocketRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/logs/ws', {
    websocket: true,
    // Rate-limit the connection upgrade: the handler does a session lookup and a
    // project-membership check (DB), so cap the connection attempt rate per client.
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (socket, req: any) => {
    const { projectId, service, level, hostname, token } = req.query as {
      projectId: string;
      service?: string | string[];
      level?: LogLevel | LogLevel[];
      hostname?: string | string[];
      token?: string;
    };

    if (!projectId) {
      socket.close(1008, 'ProjectId required');
      return;
    }

    // The auth plugin runs onRequest for this upgrade and authenticates via the
    // single-use stream ticket (?ticket=) or a legacy session token (?token=),
    // attaching the user to the request. Prefer that. Fall back to validating a
    // session token directly only if no user was attached. Either way, verify the
    // authenticated user actually has access to the requested project: the REST
    // log/trace/metric routes all gate on verifyProjectAccess; without the same
    // check here, any authenticated user could live-tail any project's logs by
    // passing a foreign projectId (cross-tenant leak).
    try {
      let userId: string | undefined = (req as any).user?.id;

      if (!userId) {
        if (!token) {
          socket.close(1008, 'Authentication required');
          return;
        }

        const session = await db
          .selectFrom('sessions')
          .innerJoin('users', 'users.id', 'sessions.user_id')
          .select(['users.id as userId', 'sessions.expires_at'])
          .where('sessions.token', '=', token)
          .executeTakeFirst();

        if (!session || new Date(session.expires_at) < new Date()) {
          socket.close(1008, 'Invalid or expired authentication token');
          return;
        }

        userId = session.userId;
      }

      const hasAccess = await verifyProjectAccess(projectId, userId);
      if (!hasAccess) {
        socket.close(1008, 'Access denied for the requested project');
        return;
      }
    } catch (error) {
      console.error('[WebSocket] Authentication error:', error);
      socket.close(1011, 'Internal Server Error');
      return;
    }

    // Generate unique subscriber ID
    const subscriberId = randomUUID();

    // Parse filter arrays
    const serviceFilter = service
      ? Array.isArray(service)
        ? service
        : [service]
      : undefined;
    const levelFilter = level ? (Array.isArray(level) ? level : [level]) : undefined;
    const hostnameFilter = hostname
      ? Array.isArray(hostname)
        ? hostname
        : [hostname]
      : undefined;

    // Track socket state for safe sending
    let isSocketOpen = true;

    // Helper function to safely send data to WebSocket
    const safeSend = (data: string): boolean => {
      if (!isSocketOpen || socket.readyState !== 1) { // 1 = OPEN
        return false;
      }
      try {
        socket.send(data);
        return true;
      } catch (error) {
        console.error(`[WebSocket:${subscriberId}] Send error:`, error);
        return false;
      }
    };

    // Define subscriber for PostgreSQL LISTEN/NOTIFY
    const subscriber: LogSubscriber = {
      id: subscriberId,
      projectId,
      services: serviceFilter,
      levels: levelFilter,

      // Notification handler: fetch logs and send to WebSocket
      onNotification: async (event: LogNotificationEvent) => {
        // Skip if socket is no longer open
        if (!isSocketOpen) {
          return;
        }

        try {
          // Fetch full logs from database (by log IDs)
          // This query is fast because log IDs are primary keys (indexed)
          const logs = await reservoir.getByIds({
            ids: event.logIds,
            projectId,
          });

          if (logs.length === 0) {
            return;
          }

          // Apply client-side filters (service, level, hostname)
          type WsLog = { id: string; time: Date; projectId: string; service: string; level: LogLevel; message: string; metadata?: Record<string, unknown>; traceId?: string; spanId?: string };
          const filteredLogs = logs.filter((log: WsLog) => {
            // Service filter
            if (serviceFilter && !serviceFilter.includes(log.service)) {
              return false;
            }

            // Level filter
            if (levelFilter && !levelFilter.includes(log.level)) {
              return false;
            }

            // Hostname filter (from metadata.hostname)
            if (hostnameFilter) {
              const logHostname = (log.metadata as Record<string, unknown> | undefined)?.hostname as string | undefined;
              if (!logHostname || !hostnameFilter.includes(logHostname)) {
                return false;
              }
            }

            return true;
          });

          if (filteredLogs.length === 0) {
            return;
          }

          // Transform to API format (reservoir returns camelCase)
          const apiLogs = filteredLogs.map((log: WsLog) => ({
            id: log.id,
            time: log.time,
            projectId: log.projectId,
            service: log.service,
            level: log.level,
            message: log.message,
            metadata: log.metadata,
            traceId: log.traceId,
            spanId: log.spanId,
          }));

          // Send to WebSocket client (safe send checks socket state)
          safeSend(JSON.stringify({ type: 'logs', logs: apiLogs }));
        } catch (error) {
          console.error(`[WebSocket:${subscriberId}] Error handling notification:`, error);
        }
      },
    };

    // Register subscriber with notification manager
    const unsubscribe = notificationManager.subscribe(subscriber);

    // Cleanup function to ensure proper resource release
    const cleanup = () => {
      if (!isSocketOpen) return; // Already cleaned up
      isSocketOpen = false;
      unsubscribe();
    };

    // Send initial connection message
    safeSend(JSON.stringify({ type: 'connected', subscriberId }));

    // Cleanup on disconnect
    socket.on('close', () => {
      console.log(`[WebSocket] Client disconnected: ${subscriberId}`);
      cleanup();
    });

    socket.on('error', (err: Error) => {
      console.error(`[WebSocket] Socket error (${subscriberId}):`, err);
      cleanup();
      // Close the socket on error to prevent memory leaks
      try {
        socket.close();
      } catch {
        // Socket may already be closed
      }
    });
  });
};

export default websocketRoutes;
