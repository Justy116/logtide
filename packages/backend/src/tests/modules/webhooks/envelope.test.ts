import { describe, it, expect } from 'vitest';
import { buildEnvelope } from '../../../modules/webhooks/envelope.js';
import { webhookEnvelopeSchema } from '@logtide/shared';

const ORG_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const PROJ_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

describe('buildEnvelope', () => {
  it('returns an envelope that validates against webhookEnvelopeSchema', () => {
    const env = buildEnvelope({
      type: 'alert.triggered',
      organizationId: ORG_ID,
      projectId: PROJ_ID,
      data: { alert_name: 'High errors', log_count: 5, threshold: 3, time_window: 60, baseline_metadata: null, link: 'https://app.logtide.dev/alerts/1' },
    });
    expect(() => webhookEnvelopeSchema.parse(env)).not.toThrow();
  });

  it('id starts with evt_ followed by a uuid', () => {
    const env = buildEnvelope({ type: 'alert.triggered', organizationId: ORG_ID, projectId: null, data: {} });
    expect(env.id).toMatch(/^evt_[0-9a-f-]{36}$/);
  });

  it('version is always 1', () => {
    const env = buildEnvelope({ type: 'monitor.status_changed', organizationId: ORG_ID, projectId: null, data: {} });
    expect(env.version).toBe(1);
  });

  it('occurredAt is a valid ISO datetime string', () => {
    const env = buildEnvelope({ type: 'error.detected', organizationId: ORG_ID, projectId: null, data: {} });
    expect(() => new Date(env.occurredAt)).not.toThrow();
    expect(new Date(env.occurredAt).toISOString()).toBe(env.occurredAt);
  });

  it('propagates organizationId, projectId (uuid), and data', () => {
    const data = { title: 'boom', message: 'x', severity: 'high', organization: { id: ORG_ID, name: 'Org' }, incident_id: 'inc-1', link: 'https://x' };
    const env = buildEnvelope({ type: 'incident.created', organizationId: ORG_ID, projectId: PROJ_ID, data });
    expect(env.organizationId).toBe(ORG_ID);
    expect(env.projectId).toBe(PROJ_ID);
    expect(env.data).toEqual(data);
  });

  it('sets projectId to null when omitted', () => {
    const env = buildEnvelope({ type: 'channel.test', organizationId: ORG_ID, data: {} });
    expect(env.projectId).toBeNull();
  });

  it('each call produces a different id', () => {
    const a = buildEnvelope({ type: 'alert.triggered', organizationId: ORG_ID, projectId: null, data: {} });
    const b = buildEnvelope({ type: 'alert.triggered', organizationId: ORG_ID, projectId: null, data: {} });
    expect(a.id).not.toBe(b.id);
  });

  it('validates all five event types', () => {
    const types = ['alert.triggered', 'incident.created', 'error.detected', 'monitor.status_changed', 'channel.test'] as const;
    for (const type of types) {
      const env = buildEnvelope({ type, organizationId: ORG_ID, projectId: null, data: {} });
      expect(() => webhookEnvelopeSchema.parse(env)).not.toThrow();
    }
  });
});
