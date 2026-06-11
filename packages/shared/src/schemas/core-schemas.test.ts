import { describe, it, expect } from 'vitest';
import {
  logLevelSchema,
  orgRoleSchema,
  sigmaLevelSchema,
  sigmaStatusSchema,
  severitySchema,
  incidentStatusSchema,
  errorGroupStatusSchema,
  exceptionLanguageSchema,
  apiKeyTypeSchema,
  logSchema,
  ingestRequestSchema,
  alertRuleSchema,
} from './index.js';

// ---------------------------------------------------------------------------
// Enum schemas
// ---------------------------------------------------------------------------

describe('logLevelSchema', () => {
  it.each(['debug', 'info', 'warn', 'error', 'critical'])('accepts %s', (v) => {
    expect(logLevelSchema.parse(v)).toBe(v);
  });
  it('rejects unknown level', () => {
    expect(() => logLevelSchema.parse('trace')).toThrow();
  });
  it('rejects non-string', () => {
    expect(() => logLevelSchema.parse(1)).toThrow();
  });
});

describe('orgRoleSchema', () => {
  it.each(['owner', 'admin', 'member'])('accepts %s', (v) => {
    expect(orgRoleSchema.parse(v)).toBe(v);
  });
  it('rejects unknown role', () => {
    expect(() => orgRoleSchema.parse('superuser')).toThrow();
  });
  it('rejects non-string', () => {
    expect(() => orgRoleSchema.parse(null)).toThrow();
  });
});

describe('sigmaLevelSchema', () => {
  it.each(['informational', 'low', 'medium', 'high', 'critical'])('accepts %s', (v) => {
    expect(sigmaLevelSchema.parse(v)).toBe(v);
  });
  it('rejects unknown level', () => {
    expect(() => sigmaLevelSchema.parse('unknown')).toThrow();
  });
  it('rejects non-string', () => {
    expect(() => sigmaLevelSchema.parse(false)).toThrow();
  });
});

describe('sigmaStatusSchema', () => {
  it.each(['experimental', 'test', 'stable', 'deprecated', 'unsupported'])('accepts %s', (v) => {
    expect(sigmaStatusSchema.parse(v)).toBe(v);
  });
  it('rejects unknown status', () => {
    expect(() => sigmaStatusSchema.parse('beta')).toThrow();
  });
  it('rejects non-string', () => {
    expect(() => sigmaStatusSchema.parse(0)).toThrow();
  });
});

describe('severitySchema', () => {
  it.each(['critical', 'high', 'medium', 'low', 'informational'])('accepts %s', (v) => {
    expect(severitySchema.parse(v)).toBe(v);
  });
  it('rejects unknown severity', () => {
    expect(() => severitySchema.parse('none')).toThrow();
  });
  it('rejects non-string', () => {
    expect(() => severitySchema.parse({})).toThrow();
  });
});

describe('incidentStatusSchema', () => {
  it.each(['open', 'investigating', 'resolved', 'false_positive'])('accepts %s', (v) => {
    expect(incidentStatusSchema.parse(v)).toBe(v);
  });
  it('rejects unknown status', () => {
    expect(() => incidentStatusSchema.parse('closed')).toThrow();
  });
  it('rejects non-string', () => {
    expect(() => incidentStatusSchema.parse(undefined)).toThrow();
  });
});

describe('errorGroupStatusSchema', () => {
  it.each(['open', 'resolved', 'ignored'])('accepts %s', (v) => {
    expect(errorGroupStatusSchema.parse(v)).toBe(v);
  });
  it('rejects unknown status', () => {
    expect(() => errorGroupStatusSchema.parse('archived')).toThrow();
  });
  it('rejects non-string', () => {
    expect(() => errorGroupStatusSchema.parse([])).toThrow();
  });
});

describe('exceptionLanguageSchema', () => {
  it.each(['nodejs', 'python', 'java', 'go', 'php', 'kotlin', 'csharp', 'rust', 'ruby', 'unknown'])(
    'accepts %s',
    (v) => {
      expect(exceptionLanguageSchema.parse(v)).toBe(v);
    },
  );
  it('rejects unknown language', () => {
    expect(() => exceptionLanguageSchema.parse('swift')).toThrow();
  });
  it('rejects non-string', () => {
    expect(() => exceptionLanguageSchema.parse(42)).toThrow();
  });
});

describe('apiKeyTypeSchema', () => {
  it.each(['write', 'full'])('accepts %s', (v) => {
    expect(apiKeyTypeSchema.parse(v)).toBe(v);
  });
  it('rejects unknown type', () => {
    expect(() => apiKeyTypeSchema.parse('read')).toThrow();
  });
  it('rejects non-string', () => {
    expect(() => apiKeyTypeSchema.parse(true)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// logSchema
// ---------------------------------------------------------------------------

const validLog = {
  service: 'api',
  level: 'info',
  message: 'hello',
};

describe('logSchema', () => {
  it('accepts a minimal valid log (defaults time)', () => {
    const r = logSchema.parse(validLog);
    expect(r.service).toBe('api');
    expect(r.level).toBe('info');
    expect(r.message).toBe('hello');
    // time is defaulted to an ISO string
    expect(typeof r.time).toBe('string');
  });

  it('accepts an explicit ISO datetime string for time', () => {
    const r = logSchema.parse({ ...validLog, time: '2025-01-15T10:30:00.000Z' });
    expect(r.time).toBe('2025-01-15T10:30:00.000Z');
  });

  it('accepts a Date object for time', () => {
    const d = new Date('2025-06-01T00:00:00.000Z');
    const r = logSchema.parse({ ...validLog, time: d });
    // schema accepts z.date() union arm; output is the Date as-is
    expect(r.time).toEqual(d);
  });

  it('rejects a non-ISO string for time', () => {
    expect(() => logSchema.parse({ ...validLog, time: 'not-a-date' })).toThrow();
  });

  it('rejects missing service', () => {
    const { service: _s, ...rest } = validLog;
    expect(() => logSchema.parse(rest)).toThrow();
  });

  it('rejects empty service', () => {
    expect(() => logSchema.parse({ ...validLog, service: '' })).toThrow();
  });

  it('rejects service longer than 100 chars', () => {
    expect(() => logSchema.parse({ ...validLog, service: 'a'.repeat(101) })).toThrow();
  });

  it('accepts service exactly 100 chars', () => {
    expect(() => logSchema.parse({ ...validLog, service: 'a'.repeat(100) })).not.toThrow();
  });

  it('rejects missing level', () => {
    const { level: _l, ...rest } = validLog;
    expect(() => logSchema.parse(rest)).toThrow();
  });

  it('rejects invalid level', () => {
    expect(() => logSchema.parse({ ...validLog, level: 'verbose' })).toThrow();
  });

  it('rejects missing message', () => {
    const { message: _m, ...rest } = validLog;
    expect(() => logSchema.parse(rest)).toThrow();
  });

  it('rejects empty message', () => {
    expect(() => logSchema.parse({ ...validLog, message: '' })).toThrow();
  });

  // optionality
  it('metadata is optional', () => {
    const r = logSchema.parse(validLog);
    expect(r.metadata).toBeUndefined();
  });

  it('accepts metadata as a record', () => {
    const r = logSchema.parse({ ...validLog, metadata: { region: 'eu', retries: 3 } });
    expect(r.metadata).toEqual({ region: 'eu', retries: 3 });
  });

  it('trace_id is optional', () => {
    expect(logSchema.parse(validLog).trace_id).toBeUndefined();
  });

  it('accepts trace_id as a string', () => {
    const r = logSchema.parse({ ...validLog, trace_id: 'abc123' });
    expect(r.trace_id).toBe('abc123');
  });

  it('span_id is optional', () => {
    expect(logSchema.parse(validLog).span_id).toBeUndefined();
  });

  it('accepts a valid 16-hex span_id (lowercase)', () => {
    const r = logSchema.parse({ ...validLog, span_id: 'a1b2c3d4e5f60708' });
    expect(r.span_id).toBe('a1b2c3d4e5f60708');
  });

  it('accepts a valid 16-hex span_id (uppercase)', () => {
    const r = logSchema.parse({ ...validLog, span_id: 'A1B2C3D4E5F60708' });
    expect(r.span_id).toBe('A1B2C3D4E5F60708');
  });

  it('rejects span_id that is not 16 hex chars', () => {
    expect(() => logSchema.parse({ ...validLog, span_id: 'tooshort' })).toThrow();
    expect(() => logSchema.parse({ ...validLog, span_id: 'a1b2c3d4e5f6070g' })).toThrow();
  });

  it('session_id is optional', () => {
    expect(logSchema.parse(validLog).session_id).toBeUndefined();
  });

  it('accepts a valid uuid for session_id', () => {
    const r = logSchema.parse({ ...validLog, session_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' });
    expect(r.session_id).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
  });

  it('rejects a non-uuid session_id', () => {
    expect(() => logSchema.parse({ ...validLog, session_id: 'not-a-uuid' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ingestRequestSchema
// ---------------------------------------------------------------------------

describe('ingestRequestSchema', () => {
  it('accepts a valid request with one log', () => {
    const r = ingestRequestSchema.parse({ logs: [validLog] });
    expect(r.logs).toHaveLength(1);
  });

  it('rejects empty logs array (min 1)', () => {
    expect(() => ingestRequestSchema.parse({ logs: [] })).toThrow();
  });

  it('rejects more than 1000 logs', () => {
    const many = Array.from({ length: 1001 }, () => validLog);
    expect(() => ingestRequestSchema.parse({ logs: many })).toThrow();
  });

  it('accepts exactly 1000 logs', () => {
    const exact = Array.from({ length: 1000 }, () => validLog);
    expect(() => ingestRequestSchema.parse({ logs: exact })).not.toThrow();
  });

  it('rejects non-array logs', () => {
    expect(() => ingestRequestSchema.parse({ logs: 'not an array' })).toThrow();
  });

  it('rejects missing logs field', () => {
    expect(() => ingestRequestSchema.parse({})).toThrow();
  });

  it('rejects an invalid log entry in the array', () => {
    expect(() => ingestRequestSchema.parse({ logs: [{ service: 'x', level: 'bad', message: 'y' }] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// alertRuleSchema
// ---------------------------------------------------------------------------

const validRule = {
  name: 'High error rate',
  enabled: true,
  level: ['error', 'critical'],
  threshold: 10,
  time_window: 60,
  email_recipients: ['ops@example.com'],
  metadata_filters: [],
};

describe('alertRuleSchema', () => {
  it('accepts a minimal valid rule', () => {
    const r = alertRuleSchema.parse(validRule);
    expect(r.name).toBe('High error rate');
  });

  it('enabled defaults to true when omitted', () => {
    const { enabled: _e, ...rest } = validRule;
    const r = alertRuleSchema.parse(rest);
    expect(r.enabled).toBe(true);
  });

  it('rejects missing name', () => {
    const { name: _n, ...rest } = validRule;
    expect(() => alertRuleSchema.parse(rest)).toThrow();
  });

  it('rejects empty name', () => {
    expect(() => alertRuleSchema.parse({ ...validRule, name: '' })).toThrow();
  });

  it('rejects name longer than 200 chars', () => {
    expect(() => alertRuleSchema.parse({ ...validRule, name: 'x'.repeat(201) })).toThrow();
  });

  it('rejects missing level', () => {
    const { level: _l, ...rest } = validRule;
    expect(() => alertRuleSchema.parse(rest)).toThrow();
  });

  it('rejects invalid log level in level array', () => {
    expect(() => alertRuleSchema.parse({ ...validRule, level: ['superverbose'] })).toThrow();
  });

  it('accepts empty level array', () => {
    // schema uses z.array(logLevelSchema) with no min; empty array should parse
    expect(() => alertRuleSchema.parse({ ...validRule, level: [] })).not.toThrow();
  });

  it('rejects missing threshold', () => {
    const { threshold: _t, ...rest } = validRule;
    expect(() => alertRuleSchema.parse(rest)).toThrow();
  });

  it('rejects non-positive threshold', () => {
    expect(() => alertRuleSchema.parse({ ...validRule, threshold: 0 })).toThrow();
    expect(() => alertRuleSchema.parse({ ...validRule, threshold: -1 })).toThrow();
  });

  it('rejects float threshold', () => {
    expect(() => alertRuleSchema.parse({ ...validRule, threshold: 1.5 })).toThrow();
  });

  it('rejects missing time_window', () => {
    const { time_window: _tw, ...rest } = validRule;
    expect(() => alertRuleSchema.parse(rest)).toThrow();
  });

  it('rejects non-positive time_window', () => {
    expect(() => alertRuleSchema.parse({ ...validRule, time_window: 0 })).toThrow();
  });

  it('rejects float time_window', () => {
    expect(() => alertRuleSchema.parse({ ...validRule, time_window: 1.5 })).toThrow();
  });

  it('rejects missing email_recipients', () => {
    const { email_recipients: _er, ...rest } = validRule;
    expect(() => alertRuleSchema.parse(rest)).toThrow();
  });

  it('rejects invalid email in email_recipients', () => {
    expect(() => alertRuleSchema.parse({ ...validRule, email_recipients: ['not-an-email'] })).toThrow();
  });

  it('service is optional', () => {
    expect(alertRuleSchema.parse(validRule).service).toBeUndefined();
  });

  it('accepts an optional service string', () => {
    const r = alertRuleSchema.parse({ ...validRule, service: 'api' });
    expect(r.service).toBe('api');
  });

  it('rejects service longer than 100 chars', () => {
    expect(() => alertRuleSchema.parse({ ...validRule, service: 'a'.repeat(101) })).toThrow();
  });

  it('webhook_url is optional', () => {
    expect(alertRuleSchema.parse(validRule).webhook_url).toBeUndefined();
  });

  it('accepts a valid webhook_url', () => {
    const r = alertRuleSchema.parse({ ...validRule, webhook_url: 'https://hooks.example.com/notify' });
    expect(r.webhook_url).toBe('https://hooks.example.com/notify');
  });

  it('rejects an invalid webhook_url', () => {
    expect(() => alertRuleSchema.parse({ ...validRule, webhook_url: 'not-a-url' })).toThrow();
  });

  it('metadata_filters defaults to empty array when omitted', () => {
    const { metadata_filters: _mf, ...rest } = validRule;
    const r = alertRuleSchema.parse(rest);
    expect(r.metadata_filters).toEqual([]);
  });
});
