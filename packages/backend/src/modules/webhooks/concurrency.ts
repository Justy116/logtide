/**
 * In-process per-organization concurrency limiter for webhook delivery (#218).
 *
 * Caps how many deliveries run at once for a single org so one tenant's slow
 * receiver can't saturate the worker pool, plus an overall global cap. Purely
 * in-memory: state dies with the process (crash-safe), no Redis dependency, so
 * it works on both queue backends. A cross-instance cap is future work.
 */

interface LimiterOptions {
  perOrg: number;
  global: number;
}

export class OrgConcurrencyLimiter {
  private readonly perOrg: number;
  private readonly global: number;
  private globalActive = 0;
  private orgActive = new Map<string, number>();
  private waiters: Array<{ orgId: string; resolve: () => void }> = [];

  constructor(opts: LimiterOptions) {
    this.perOrg = Math.max(1, opts.perOrg);
    this.global = Math.max(1, opts.global);
  }

  async run<T>(orgId: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(orgId);
    try {
      return await task();
    } finally {
      this.release(orgId);
    }
  }

  private canRun(orgId: string): boolean {
    return this.globalActive < this.global && (this.orgActive.get(orgId) ?? 0) < this.perOrg;
  }

  private acquire(orgId: string): Promise<void> {
    if (this.canRun(orgId)) {
      this.globalActive++;
      this.orgActive.set(orgId, (this.orgActive.get(orgId) ?? 0) + 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push({ orgId, resolve });
    });
  }

  private release(orgId: string): void {
    this.globalActive--;
    this.orgActive.set(orgId, Math.max(0, (this.orgActive.get(orgId) ?? 1) - 1));

    // Wake the first waiter that can now run.
    const idx = this.waiters.findIndex((w) => this.canRun(w.orgId));
    if (idx === -1) return;
    const [waiter] = this.waiters.splice(idx, 1);
    this.globalActive++;
    this.orgActive.set(waiter.orgId, (this.orgActive.get(waiter.orgId) ?? 0) + 1);
    waiter.resolve();
  }
}
