import { describe, it, expect } from 'vitest';
import { withContext, currentOrNull } from '@logtide/shared/context';
import { formatContextComment } from './kysely-plugin.js';

describe('SQL comment injection helpers', () => {
  it('formatContextComment can be invoked deterministically', () => {
    const out = formatContextComment({
      requestId: 'r1',
      origin: 'http',
      organizationId: 'o1',
      actor: { type: 'user', id: 'u1' },
    });
    expect(out).toMatch(/^\/\* req=r1 origin=http org=o1 actor=user:u1 \*\/ $/);
  });

  it('manually-built patched query function prepends comment', async () => {
    const captured: string[] = [];
    const fakeOriginal = (sql: string) => {
      captured.push(sql);
      return Promise.resolve({ rows: [], rowCount: 0 });
    };
    const patched = (...args: any[]) => {
      const ctx = currentOrNull();
      if (!ctx) return fakeOriginal(...(args as [string]));
      const comment = formatContextComment(ctx);
      args[0] = comment + args[0];
      return fakeOriginal(...(args as [string]));
    };

    await withContext({ requestId: 'rZ', organizationId: 'oZ' }, async () => {
      await patched('SELECT 1');
    });

    expect(captured[0]).toMatch(/^\/\* req=rZ /);
  });
});
