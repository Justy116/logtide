import { describe, it, expect } from 'vitest';
import { OrgConcurrencyLimiter } from '../../../modules/webhooks/concurrency.js';

describe('OrgConcurrencyLimiter', () => {
  it('runs up to N tasks per org concurrently and queues the rest', async () => {
    const limiter = new OrgConcurrencyLimiter({ perOrg: 2, global: 100 });
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => limiter.run('org-1', task)));
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('isolates orgs from each other', async () => {
    const limiter = new OrgConcurrencyLimiter({ perOrg: 1, global: 100 });
    const order: string[] = [];
    await Promise.all([
      limiter.run('a', async () => { order.push('a'); }),
      limiter.run('b', async () => { order.push('b'); }),
    ]);
    expect(order.sort()).toEqual(['a', 'b']);
  });

  it('releases a slot even when the task throws', async () => {
    const limiter = new OrgConcurrencyLimiter({ perOrg: 1, global: 100 });
    await expect(limiter.run('org-1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(limiter.run('org-1', async () => 'ok')).resolves.toBe('ok');
  });
});
