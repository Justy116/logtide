import { createConnection } from 'net';
import type { Kysely } from 'kysely';
import isSafeRegex from 'safe-regex2';
import type { Database } from '../../database/types.js';
import type { IReservoir } from '@logtide/reservoir';
import type { CheckResult, HttpConfig, ErrorCode } from './types.js';
import { safeFetch, resolveAndValidateHost, SsrfBlockedError } from '../../utils/ssrf-guard.js';

/**
 * HTTP/HTTPS health check.
 * Never surfaces raw error messages - maps all failures to sanitized error codes.
 *
 * allowPrivate lets self-hosted deployments monitor internal services; when
 * false (default) the target and every redirect hop are validated against the
 * SSRF guard before connecting.
 */
export async function runHttpCheck(
  target: string,
  timeoutSeconds: number,
  config: HttpConfig = {},
  allowPrivate = false
): Promise<CheckResult> {
  const { method = 'GET', expectedStatus = 200, headers = {}, bodyAssertion } = config;
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const response = await safeFetch(
      target,
      {
        method,
        headers: { 'User-Agent': 'LogTide-Monitor/1.0', ...headers },
        signal: controller.signal,
      },
      { allowPrivate }
    );

    const responseTimeMs = Date.now() - start;
    const statusCode = response.status;

    if (statusCode !== expectedStatus) {
      return { status: 'down', responseTimeMs, statusCode, errorCode: 'http_error' };
    }

    if (bodyAssertion) {
      const body = await response.text();
      let passes: boolean;
      if (bodyAssertion.type === 'contains') {
        passes = body.includes(bodyAssertion.value);
      } else {
        // Limit body size and pattern length to mitigate ReDoS, and reject
        // patterns flagged as unsafe by safe-regex2 (catastrophic backtracking).
        const safeBody = body.slice(0, 10000);
        const safePattern = bodyAssertion.pattern.slice(0, 256);
        if (!isSafeRegex(safePattern)) {
          return { status: 'down', responseTimeMs, statusCode, errorCode: 'http_error' };
        }
        try {
          passes = new RegExp(safePattern).test(safeBody); // lgtm[js/regex-injection] - validated by isSafeRegex above
        } catch {
          return { status: 'down', responseTimeMs, statusCode, errorCode: 'http_error' };
        }
      }

      if (!passes) {
        return { status: 'down', responseTimeMs, statusCode, errorCode: 'http_error' };
      }
    }


    return { status: 'up', responseTimeMs, statusCode, errorCode: null };
  } catch (err: unknown) {
    const responseTimeMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : '';
    let errorCode: ErrorCode;

    if (err instanceof SsrfBlockedError) {
      errorCode = 'blocked';
    } else if (err instanceof Error && err.name === 'AbortError') {
      errorCode = 'timeout';
    } else if (msg.includes('ECONNREFUSED')) {
      errorCode = 'connection_refused';
    } else if (msg.includes('ENOTFOUND') || msg.includes('EAI_')) {
      errorCode = 'dns_error';
    } else if (msg.includes('SSL') || msg.includes('certificate') || msg.includes('CERT_')) {
      errorCode = 'ssl_error';
    } else {
      errorCode = 'unexpected';
    }

    return { status: 'down', responseTimeMs, statusCode: null, errorCode };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TCP connectivity check - measures time to establish connection.
 *
 * The host is resolved and validated against the SSRF guard, then the socket is
 * pinned to the validated address so a hostname can't rebind to an internal IP
 * between validation and connect.
 */
export async function runTcpCheck(
  host: string,
  port: number,
  timeoutSeconds: number,
  allowPrivate = false
): Promise<CheckResult> {
  const start = Date.now();

  let connectHost: string;
  try {
    const [address] = await resolveAndValidateHost(host, allowPrivate);
    connectHost = address;
  } catch {
    return { status: 'down', responseTimeMs: Date.now() - start, statusCode: null, errorCode: 'blocked' };
  }

  return new Promise((resolve) => {
    const socket = createConnection({ host: connectHost, port });

    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ status: 'down', responseTimeMs: Date.now() - start, statusCode: null, errorCode: 'timeout' });
    }, timeoutSeconds * 1000);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: 'up', responseTimeMs: Date.now() - start, statusCode: null, errorCode: null });
    });

    socket.on('error', (err: Error) => {
      clearTimeout(timer);
      const msg = err.message;
      let errorCode: ErrorCode = 'unexpected';
      if (msg.includes('ECONNREFUSED')) errorCode = 'connection_refused';
      else if (msg.includes('ENOTFOUND') || msg.includes('EAI_')) errorCode = 'dns_error';
      resolve({ status: 'down', responseTimeMs: Date.now() - start, statusCode: null, errorCode });
    });
  });
}

/**
 * Heartbeat check - looks for a recent heartbeat ping in monitor_results.
 * Returns 'up' if a heartbeat was received within the grace window (interval * 1.5).
 */
export async function runHeartbeatCheck(
  monitorId: string,
  intervalSeconds: number,
  db: Kysely<Database>
): Promise<CheckResult> {
  const graceMs = intervalSeconds * 1.5 * 1000;
  const since = new Date(Date.now() - graceMs);

  const recent = await db
    .selectFrom('monitor_results')
    .select('time')
    .where('monitor_id', '=', monitorId)
    .where('is_heartbeat', '=', true)
    .where('status', '=', 'up')
    .where('time', '>=', since)
    .orderBy('time', 'desc')
    .limit(1)
    .executeTakeFirst();

  if (recent) {
    return { status: 'up', responseTimeMs: null, statusCode: null, errorCode: null };
  }

  return { status: 'down', responseTimeMs: null, statusCode: null, errorCode: 'no_heartbeat' };
}

/**
 * Log-based heartbeat check - queries the reservoir for the last log from a service.
 * Returns 'up' if a log was received within the grace window (interval * 1.5).
 * Works across all storage engines (TimescaleDB, ClickHouse, MongoDB).
 */
export async function runLogHeartbeatCheck(
  serviceName: string,
  projectId: string,
  graceSeconds: number,
  reservoir: IReservoir
): Promise<CheckResult> {
  const graceMs = graceSeconds * 1000;
  const since = new Date(Date.now() - graceMs);

  const result = await reservoir.query({
    projectId,
    service: serviceName,
    from: since,
    to: new Date(),
    limit: 1,
    sortBy: 'time',
    sortOrder: 'desc',
  });

  if (result.logs.length > 0) {
    return { status: 'up', responseTimeMs: null, statusCode: null, errorCode: null };
  }

  return { status: 'down', responseTimeMs: null, statusCode: null, errorCode: 'no_heartbeat' };
}

/**
 * Parse "host:port" string for TCP monitors.
 * Handles IPv6 addresses like "[::1]:5432".
 */
export function parseTcpTarget(target: string): { host: string; port: number } {
  // IPv6 with brackets: [::1]:5432
  const ipv6Match = target.match(/^\[(.+)\]:(\d+)$/);
  if (ipv6Match) {
    return { host: ipv6Match[1], port: parseInt(ipv6Match[2], 10) };
  }
  // Standard host:port
  const lastColon = target.lastIndexOf(':');
  if (lastColon === -1) throw new Error('TCP target must be host:port');
  return {
    host: target.slice(0, lastColon),
    port: parseInt(target.slice(lastColon + 1), 10),
  };
}
