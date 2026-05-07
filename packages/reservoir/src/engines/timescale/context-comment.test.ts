import { describe, it, expect, vi } from 'vitest';
import { withContext } from '@logtide/shared';
import { TimescaleEngine } from './timescale-engine.js';

describe('TimescaleEngine context comment', () => {
  it('prepends /* req=... */ to SQL when context is set', async () => {
    const captured: string[] = [];
    const fakePool = {
      query: vi.fn(async (sql: string) => {
        captured.push(sql);
        return { rows: [{ now: new Date() }], rowCount: 1 };
      }),
      end: vi.fn(),
    } as unknown as import('pg').Pool;

    const engine = new TimescaleEngine(
      { host: 'x', port: 0, database: 'x', user: 'x', password: 'x', schema: 'public' } as any,
      { pool: fakePool, skipInitialize: true }
    );

    await withContext({ requestId: 'req-99', organizationId: 'org-z' }, async () => {
      await engine.healthCheck();
    });

    expect(captured.some((s) => s.startsWith('/* req=req-99'))).toBe(true);
  });

  it('passes SQL unchanged when no context', async () => {
    const captured: string[] = [];
    const fakePool = {
      query: vi.fn(async (sql: string) => {
        captured.push(sql);
        return { rows: [{ now: new Date() }], rowCount: 1 };
      }),
      end: vi.fn(),
    } as unknown as import('pg').Pool;

    const engine = new TimescaleEngine(
      { host: 'x', port: 0, database: 'x', user: 'x', password: 'x', schema: 'public' } as any,
      { pool: fakePool, skipInitialize: true }
    );

    await engine.healthCheck();
    expect(captured.every((s) => !s.startsWith('/* req='))).toBe(true);
  });
});
