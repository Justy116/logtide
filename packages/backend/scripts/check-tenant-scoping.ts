import { Project, SyntaxKind, Node } from 'ts-morph';
import { TENANT_TABLES } from '../src/database/tenant-tables.js';

const SCOPE_RE = /organization_id|project_id/;
const OK_MARKER = 'tenant-scope-ok';
const QUERY_STARTERS = new Set(['selectFrom', 'updateTable', 'deleteFrom']);

interface Finding {
  file: string;
  line: number;
  table: string;
  scoped: boolean;
  marked: boolean;
}

function tableLiteral(call: Node): string | null {
  const args = call.asKind(SyntaxKind.CallExpression)?.getArguments() ?? [];
  const first = args[0];
  if (first && Node.isStringLiteral(first)) {
    // handles "logs" and "logs as l"
    return first.getLiteralValue().split(/\s+as\s+/i)[0].trim();
  }
  return null;
}

// Walk up the fluent chain from the starter call to the full statement expression.
function chainTop(starter: Node): Node {
  let top: Node = starter;
  let cur: Node | undefined = starter;
  while (cur) {
    const parent = cur.getParent();
    if (parent && (Node.isPropertyAccessExpression(parent) || Node.isCallExpression(parent))) {
      top = parent;
      cur = parent;
    } else {
      break;
    }
  }
  return top;
}

function analyze(globs: string[]): Finding[] {
  const project = new Project({ tsConfigFilePath: 'tsconfig.json', skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(globs);
  const findings: Finding[] = [];

  for (const sf of project.getSourceFiles()) {
    const fullText = sf.getFullText();
    const lines = fullText.split('\n');

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      if (!QUERY_STARTERS.has(expr.getName())) continue;
      const table = tableLiteral(call);
      if (!table || !TENANT_TABLES.has(table)) continue;

      const top = chainTop(call);
      const text = top.getText();
      const scoped = SCOPE_RE.test(text);
      const line = call.getStartLineNumber();

      const marked = text.includes(OK_MARKER) || (() => {
        const around = [lines[line - 2], lines[line - 1], lines[line]].join('\n');
        return around.includes(OK_MARKER);
      })();

      findings.push({ file: sf.getFilePath(), line, table, scoped, marked });
    }
  }
  return findings;
}

function main() {
  const reportMode = process.argv.includes('--report');
  const findings = analyze(['src/**/*.ts', '!src/**/*.test.ts', '!src/tests/**']);
  const violations = findings.filter((f) => !f.scoped && !f.marked);

  if (reportMode) {
    for (const f of findings) {
      const status = f.scoped ? 'scoped' : f.marked ? 'marked-ok' : 'UNSCOPED';
      console.log(`${status}\t${f.table}\t${f.file}:${f.line}`);
    }
    console.log(`\n${findings.length} tenant-table access sites, ${violations.length} unscoped.`);
    return;
  }

  if (violations.length > 0) {
    console.error(`Found ${violations.length} unscoped tenant-table queries:\n`);
    for (const v of violations) console.error(`  ${v.table}  ${v.file}:${v.line}`);
    console.error(`\nAdd an organization_id/project_id filter, or annotate with "// ${OK_MARKER}: <reason>" if intentionally global.`);
    process.exit(1);
  }
  console.log(`OK: all ${findings.length} tenant-table access sites are scoped.`);
}

main();
