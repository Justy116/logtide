import { describe, it, expect } from 'vitest';
import { serializeContext, deserializeContext } from './serialize.js';
import type { RequestContext } from './types.js';

const httpCtx: RequestContext = {
  requestId: 'req-abc',
  origin: 'http',
  actor: { type: 'user', id: 'u1', email: 'a@b.test' },
  organizationId: 'org-1',
  projectId: 'proj-1',
  ip: '10.0.0.1',
  userAgent: 'curl/8',
};

describe('serializeContext', () => {
  it('round-trips an http context, flipping origin to job', () => {
    const ser = serializeContext(httpCtx);
    expect(ser.v).toBe(1);
    expect(ser.requestId).toBe('req-abc');

    const back = deserializeContext(ser);
    expect(back).toMatchObject({
      requestId: 'req-abc',
      origin: 'job',
      actor: httpCtx.actor,
      organizationId: 'org-1',
      projectId: 'proj-1',
    });
  });

  it('returns undefined for unknown version (graceful fallback)', () => {
    expect(deserializeContext({ v: 99, requestId: 'x' } as any)).toBeUndefined();
  });

  it('returns undefined for null/undefined input', () => {
    expect(deserializeContext(null as any)).toBeUndefined();
    expect(deserializeContext(undefined as any)).toBeUndefined();
  });

  it('returns undefined for malformed payload (zod fails)', () => {
    expect(deserializeContext({ v: 1, foo: 'bar' } as any)).toBeUndefined();
  });
});
