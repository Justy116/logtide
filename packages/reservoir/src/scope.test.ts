import { describe, it, expect } from 'vitest';
import { GLOBAL_SCOPE } from './index.js';
import type { QueryParams } from './core/types.js';

describe('reservoir log query scope', () => {
  it('exports a GLOBAL_SCOPE sentinel', () => {
    expect(GLOBAL_SCOPE).toBeDefined();
  });

  it('requires projectId on QueryParams at the type level', () => {
    // @ts-expect-error projectId is required
    const _bad: QueryParams = { from: new Date(), to: new Date() };
    void _bad;
    // valid with projectId:
    const _ok: QueryParams = { projectId: 'p1', from: new Date(), to: new Date() };
    void _ok;
    // valid with GLOBAL_SCOPE:
    const _admin: QueryParams = { projectId: GLOBAL_SCOPE, from: new Date(), to: new Date() };
    void _admin;
  });

  it('does not expose organizationId on log QueryParams', () => {
    // @ts-expect-error organizationId is not a valid log query field
    const _x: QueryParams = { projectId: 'p1', organizationId: 'o1', from: new Date(), to: new Date() };
    void _x;
  });
});
