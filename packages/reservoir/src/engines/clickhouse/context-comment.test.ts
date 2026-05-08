import { describe, it, expect, vi } from 'vitest';
import { withContext } from '@logtide/shared/context';
import { ClickHouseEngine } from './clickhouse-engine.js';

describe('ClickHouseEngine context propagation', () => {
  it('sets query_id and prepends SQL comment when context is set', async () => {
    const seen: any[] = [];
    const fakeClient = {
      command: vi.fn(async (args: any) => {
        seen.push({ kind: 'command', ...args });
        return {};
      }),
      query: vi.fn(async (args: any) => {
        seen.push({ kind: 'query', ...args });
        return { json: async () => ({ data: [] }) };
      }),
      insert: vi.fn(async () => ({})),
      ping: vi.fn(async () => ({ success: true })),
      close: vi.fn(),
    } as any;

    const engine = new ClickHouseEngine(
      { host: 'http://x', port: 0, database: 'x', user: 'x', password: 'x' } as any,
      { client: fakeClient, skipInitialize: true }
    );

    await withContext({ requestId: 'req-cc', organizationId: 'org-cc' }, async () => {
      await engine.healthCheck();
    });

    const allArgs = seen.flatMap((s) => [s.query, s.query_id].filter(Boolean));
    expect(allArgs.some((s) => typeof s === 'string' && s.startsWith('/* req=req-cc'))).toBe(true);
    expect(seen.some((s) => typeof s.query_id === 'string' && s.query_id.startsWith('req-cc'))).toBe(true);
  });
});
