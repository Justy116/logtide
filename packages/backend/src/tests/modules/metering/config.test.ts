import { describe, it, expect } from 'vitest';
import { configSchema } from '../../../config/index.js';

describe('metering config', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    API_KEY_SECRET: 'x'.repeat(32),
  };

  it('defaults metering on with sane buffer settings', () => {
    const cfg = configSchema.parse(base);
    expect(cfg.METERING_ENABLED).toBe(true);
    expect(cfg.METERING_FLUSH_INTERVAL_MS).toBe(5000);
    expect(cfg.METERING_FLUSH_MAX_BUFFER).toBe(500);
  });

  it('parses overrides from env strings', () => {
    const cfg = configSchema.parse({
      ...base,
      METERING_ENABLED: 'false',
      METERING_FLUSH_INTERVAL_MS: '1000',
      METERING_FLUSH_MAX_BUFFER: '10',
    });
    expect(cfg.METERING_ENABLED).toBe(false);
    expect(cfg.METERING_FLUSH_INTERVAL_MS).toBe(1000);
    expect(cfg.METERING_FLUSH_MAX_BUFFER).toBe(10);
  });
});
