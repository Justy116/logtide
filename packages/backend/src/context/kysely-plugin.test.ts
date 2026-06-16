import { describe, it, expect } from 'vitest';
import { formatContextComment, safeForComment } from './kysely-plugin.js';

describe('formatContextComment', () => {
  it('formats basic context', () => {
    const out = formatContextComment({
      requestId: 'req-1',
      origin: 'http',
      organizationId: 'org-1',
      actor: { type: 'user', id: 'u1' },
    });
    expect(out).toBe('/* req=req-1 origin=http org=org-1 actor=user:u1 */ ');
  });

  it('uses dash placeholder for null fields', () => {
    const out = formatContextComment({
      requestId: 'req-1',
      origin: 'system',
      organizationId: null,
      actor: { type: 'system', id: null },
    });
    expect(out).toBe('/* req=req-1 origin=system org=- actor=system:- */ ');
  });
});

describe('safeForComment', () => {
  it('strips dangerous characters', () => {
    expect(safeForComment('a*/b\nc')).toBe('abc');
  });
  it('returns dash for empty result', () => {
    expect(safeForComment('***')).toBe('-');
    expect(safeForComment(null)).toBe('-');
  });
});
