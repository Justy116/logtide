import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  RootOperationNode,
  QueryResult,
  UnknownRow,
} from 'kysely';
import { TENANT_TABLES } from './tenant-tables.js';

const SCOPE_COLUMNS = new Set(['organization_id', 'project_id']);

export class TenantScopeError extends Error {
  constructor(table: string, kind: string) {
    super(
      `Tenant scope guard: ${kind} on tenant table "${table}" has no organization_id ` +
        `or project_id reference. Add a scope filter, or if this is intentionally ` +
        `global, route it through an explicitly-global path.`
    );
    this.name = 'TenantScopeError';
  }
}

function targetTables(node: RootOperationNode): string[] {
  const tables: string[] = [];
  const anyNode = node as unknown as Record<string, any>;
  const fromTables = anyNode.from?.froms ?? [];
  for (const f of fromTables) {
    const name = f?.table?.identifier?.name ?? f?.identifier?.name;
    if (typeof name === 'string') tables.push(name);
  }
  const intoName = anyNode.into?.table?.identifier?.name;
  if (typeof intoName === 'string') tables.push(intoName);
  const updateName = anyNode.table?.table?.identifier?.name ?? anyNode.table?.identifier?.name;
  if (typeof updateName === 'string') tables.push(updateName);
  return tables;
}

function referencesScopeColumn(node: unknown): boolean {
  if (node == null || typeof node !== 'object') return false;
  const n = node as Record<string, any>;
  if (n.kind === 'ColumnNode' && SCOPE_COLUMNS.has(n.column?.name)) return true;
  for (const key of Object.keys(n)) {
    const v = n[key];
    if (Array.isArray(v)) {
      for (const item of v) if (referencesScopeColumn(item)) return true;
    } else if (typeof v === 'object' && referencesScopeColumn(v)) {
      return true;
    }
  }
  return false;
}

export class TenantScopeGuardPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const node = args.node;
    const kind = node.kind;
    if (kind !== 'SelectQueryNode' && kind !== 'UpdateQueryNode' && kind !== 'DeleteQueryNode') {
      return node;
    }
    const tenantTargets = targetTables(node).filter((t) => TENANT_TABLES.has(t));
    if (tenantTargets.length === 0) return node;
    if (referencesScopeColumn(node)) return node;
    throw new TenantScopeError(tenantTargets[0], kind);
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
