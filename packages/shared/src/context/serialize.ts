import { z } from 'zod';
import type { RequestContext, SerializedContext } from './types.js';
import { SERIALIZED_CONTEXT_VERSION } from './types.js';

const ActorSchema = z.object({
  type: z.enum(['user', 'apiKey', 'system']),
  id: z.string().nullable(),
  email: z.string().optional(),
  apiKeyType: z.enum(['write', 'full']).optional(),
});

const SerializedContextSchema = z.object({
  v: z.literal(1),
  requestId: z.string().min(1),
  origin: z.enum(['http', 'job', 'system']),
  actor: ActorSchema,
  organizationId: z.string().nullable(),
  projectId: z.string().nullable(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  systemReason: z.string().optional(),
});

export function serializeContext(ctx: RequestContext): SerializedContext {
  return {
    v: SERIALIZED_CONTEXT_VERSION,
    requestId: ctx.requestId,
    origin: ctx.origin,
    actor: ctx.actor,
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    systemReason: ctx.systemReason,
  };
}

/**
 * Returns undefined on any error: unknown version, malformed payload, etc.
 * Caller must fall back to runAsSystem in that case (rolling-deploy safe).
 */
export function deserializeContext(input: unknown): RequestContext | undefined {
  if (input == null || typeof input !== 'object') return undefined;
  if ((input as { v?: number }).v !== SERIALIZED_CONTEXT_VERSION) return undefined;

  const parsed = SerializedContextSchema.safeParse(input);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  return {
    requestId: data.requestId,
    origin: 'job', // jobs always run with origin=job, regardless of producer origin
    actor: data.actor,
    organizationId: data.organizationId,
    projectId: data.projectId,
    ip: data.ip,
    userAgent: data.userAgent,
    systemReason: data.systemReason,
  };
}
