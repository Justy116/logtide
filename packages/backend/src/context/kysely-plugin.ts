import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely';

/**
 * v1 placeholder. The actual SQL comment injection happens at the pg.Pool level
 * (see database/connection.ts) so the comment lands in front of the wire query
 * without depending on Kysely AST internals (which differ per query kind).
 *
 * Kept as a stub so future work can move comment injection back into the plugin
 * if Kysely exposes a stable RawNode-prefix API.
 */
export class ContextSqlCommentPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return args.node;
  }
  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}

const SAFE_RE = /[^a-zA-Z0-9_:-]/g;

export function safeForComment(value: string | null | undefined): string {
  if (!value) return '-';
  const cleaned = value.replace(SAFE_RE, '');
  return cleaned.length > 0 ? cleaned : '-';
}

export function formatContextComment(ctx: {
  requestId: string;
  origin: string;
  organizationId: string | null;
  actor: { type: string; id: string | null };
}): string {
  const actor = `${safeForComment(ctx.actor.type)}:${safeForComment(ctx.actor.id)}`;
  return `/* req=${safeForComment(ctx.requestId)} origin=${safeForComment(
    ctx.origin
  )} org=${safeForComment(ctx.organizationId)} actor=${actor} */ `;
}
