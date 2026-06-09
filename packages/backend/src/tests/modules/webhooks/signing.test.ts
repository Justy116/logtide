import { describe, it, expect } from 'vitest';
import { signBody, verifySignature, buildSignatureHeaders } from '../../../modules/webhooks/signing.js';

describe('webhook signing', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ hello: 'world' });
  const ts = 1700000000;

  it('produces a stable HMAC over `${ts}.${body}`', () => {
    const a = signBody(secret, ts, body);
    const b = signBody(secret, ts, body);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a correct signature and rejects a tampered one', () => {
    const sig = signBody(secret, ts, body);
    expect(verifySignature(secret, ts, body, sig)).toBe(true);
    expect(verifySignature(secret, ts, body, sig.replace(/.$/, '0'))).toBe(false);
    expect(verifySignature(secret, ts, '{"hello":"mars"}', sig)).toBe(false);
  });

  it('builds the documented headers', () => {
    const headers = buildSignatureHeaders(secret, body, ts);
    expect(headers['X-Logtide-Timestamp']).toBe('1700000000');
    expect(headers['X-Logtide-Signature']).toBe(`t=1700000000,v1=${signBody(secret, ts, body)}`);
  });
});
