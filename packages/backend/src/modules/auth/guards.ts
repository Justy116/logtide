import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Guard for read-only endpoints.
 *
 * Write-only API keys (type === 'write') are not allowed to call query endpoints.
 * Session-authenticated requests (request.user is set) always pass.
 *
 * Returns true if the request is allowed to proceed, false if a 403 was sent.
 */
export async function requireFullAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  // Session-based auth: always allowed
  if ((request as any).user) return true;

  // API key auth: check scope
  if (request.apiKeyType === 'write') {
    reply.code(403).send({
      error: 'Forbidden',
      message: 'This API key has write-only access. Use a full-access key to query logs.',
    });
    return false;
  }

  return true;
}

/**
 * Resolve the effective project ID for a query request and enforce tenant isolation.
 *
 * Session auth  -> returns queryProjectId as-is (the route handler's verifyProjectAccess
 *                  call is responsible for authorisation).
 * API-key auth  -> the key is always bound to request.projectId.
 *                  - If queryProjectId is absent: use request.projectId.
 *                  - If queryProjectId matches request.projectId: ok.
 *                  - If queryProjectId differs: send 403 and return null.
 *
 * Returns the resolved project ID (string | string[]) or null when a 403 was already sent.
 */
export async function resolveQueryProjectId(
  request: FastifyRequest,
  reply: FastifyReply,
  queryProjectId: string | string[] | undefined,
): Promise<string | string[] | undefined | null> {
  // Session-based auth: no enforcement here, verifyProjectAccess handles it downstream
  if ((request as any).user) {
    return queryProjectId;
  }

  // API-key auth path
  const boundProjectId = request.projectId; // set by auth plugin for every valid API key

  if (!boundProjectId) {
    // Key has no bound project (shouldn't happen with current schema, but be safe).
    // Let the caller's "no projectId" 400 handler fire.
    return queryProjectId;
  }

  if (!queryProjectId) {
    // No projectId in query params - default to the key's project
    return boundProjectId;
  }

  // queryProjectId was explicitly provided - enforce it matches the key's project
  const requestedIds = Array.isArray(queryProjectId) ? queryProjectId : [queryProjectId];
  for (const pid of requestedIds) {
    if (pid !== boundProjectId) {
      reply.code(403).send({ error: 'forbidden' });
      return null;
    }
  }

  return queryProjectId;
}
