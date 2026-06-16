/**
 * HMAC-SHA256 signing for outbound webhooks (#218).
 *
 * Signed string is `${unixSeconds}.${body}`. Receivers verify by recomputing
 * the HMAC over the same string with their shared secret. Headers:
 *   X-Logtide-Signature: t=<unix>,v1=<hexHmac>
 *   X-Logtide-Timestamp: <unix>
 */
import { createHmac, timingSafeEqual } from 'crypto';

export function signBody(secret: string, unixSeconds: number, body: string): string {
  return createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex');
}

export function verifySignature(
  secret: string,
  unixSeconds: number,
  body: string,
  signature: string
): boolean {
  const expected = signBody(secret, unixSeconds, body);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildSignatureHeaders(
  secret: string,
  body: string,
  unixSeconds: number
): Record<string, string> {
  const sig = signBody(secret, unixSeconds, body);
  return {
    'X-Logtide-Timestamp': String(unixSeconds),
    'X-Logtide-Signature': `t=${unixSeconds},v1=${sig}`,
  };
}
