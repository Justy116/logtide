import { describe, it, expect, vi } from 'vitest';
import { withContext } from '@logtide/shared';
import { MongoDBEngine } from './mongodb-engine.js';

describe('MongoDBEngine context propagation', () => {
  it('passes a $comment option when context is set', async () => {
    const callsWithOptions: any[] = [];
    const cursor = {
      toArray: async () => [],
      project: () => cursor,
      sort: () => cursor,
      skip: () => cursor,
      limit: () => cursor,
    };
    const collection = {
      find: vi.fn((_filter: any, options?: any) => {
        callsWithOptions.push({ kind: 'find', options });
        return cursor;
      }),
      countDocuments: vi.fn((_filter: any, options?: any) => {
        callsWithOptions.push({ kind: 'countDocuments', options });
        return Promise.resolve(0);
      }),
      aggregate: vi.fn((_pipeline: any, options?: any) => {
        callsWithOptions.push({ kind: 'aggregate', options });
        return cursor;
      }),
      findOne: vi.fn((_filter: any, options?: any) => {
        callsWithOptions.push({ kind: 'findOne', options });
        return Promise.resolve(null);
      }),
      insertMany: vi.fn(() => Promise.resolve({ insertedCount: 0, insertedIds: {} })),
      deleteMany: vi.fn(() => Promise.resolve({ deletedCount: 0 })),
    } as any;
    const db = {
      collection: () => collection,
      command: vi.fn(() => Promise.resolve({ ok: 1 })),
    } as any;

    const engine = new MongoDBEngine(
      { uri: 'mongodb://x' } as any,
      { db, skipInitialize: true } as any
    );

    await withContext({ requestId: 'req-mm', organizationId: 'org-mm' }, async () => {
      // any read-side method works; pick countDocuments
      await (engine as any).count({ projectId: 'p1', filters: [] }).catch(() => {});
    });

    const opts = callsWithOptions.find((c) => c.options?.comment)?.options;
    expect(opts?.comment).toMatch(/req=req-mm/);
  });
});
