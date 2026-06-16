import { describe, it, expect } from 'vitest';
import { configSchema } from '../../config/index.js';

describe('capability/quota config', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    API_KEY_SECRET: 'x'.repeat(32),
  };

  it('defaults the quota evaluator on with a 60s interval', () => {
    const cfg = configSchema.parse(base);
    expect(cfg.QUOTA_EVALUATOR_ENABLED).toBe(true);
    expect(cfg.QUOTA_EVALUATOR_INTERVAL_MS).toBe(60000);
  });

  it('parses overrides from env strings', () => {
    const cfg = configSchema.parse({
      ...base,
      QUOTA_EVALUATOR_ENABLED: 'false',
      QUOTA_EVALUATOR_INTERVAL_MS: '15000',
    });
    expect(cfg.QUOTA_EVALUATOR_ENABLED).toBe(false);
    expect(cfg.QUOTA_EVALUATOR_INTERVAL_MS).toBe(15000);
  });
});
