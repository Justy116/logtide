import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { ApiKeyType } from '@logtide/shared';
import { context, type Actor, type RequestContext } from '@logtide/shared';

type AuthDecoratedRequest = FastifyRequest & {
  organizationId?: string;
  projectId?: string;
  apiKeyId?: string;
  apiKeyType?: ApiKeyType;
  user?: { id: string; email: string };
};

function mapApiKeyType(t: ApiKeyType | undefined): Actor['apiKeyType'] {
  if (t === 'write') return 'ingest';
  if (t === 'full') return 'admin';
  return undefined;
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request) => {
    const r = request as AuthDecoratedRequest;

    const actor: Actor = r.user
      ? { type: 'user', id: r.user.id, email: r.user.email }
      : r.apiKeyId
      ? { type: 'apiKey', id: r.apiKeyId, apiKeyType: mapApiKeyType(r.apiKeyType) }
      : { type: 'system', id: null };

    const userAgentHeader = r.headers['user-agent'];
    const userAgent =
      typeof userAgentHeader === 'string' ? userAgentHeader : undefined;

    const ctx: RequestContext = {
      requestId: r.id,
      origin: 'http',
      actor,
      organizationId: r.organizationId ?? null,
      projectId: r.projectId ?? null,
      ip: r.ip,
      userAgent,
    };
    context.enterWith(ctx);
  });
};

export const contextPlugin = fp(plugin, {
  name: 'context',
  fastify: '5.x',
});
