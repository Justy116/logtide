# Outbound Webhooks

LogTide delivers events (alerts, anomalies, errors, monitor status changes, security incidents, and notification-channel webhooks) to your endpoints through a centralized dispatcher with SSRF protection, retry with exponential backoff, a dead-letter queue, and delivery logging.

## Delivery semantics

- **Retries:** transient failures (network errors, timeouts, HTTP 5xx, 429) are retried with exponential backoff (1s, 5s, 25s, 2m, 10m), up to a configurable maximum (`WEBHOOK_MAX_ATTEMPTS`, default 5). Non-transient failures (other 4xx) are not retried.
- **Dead-letter queue:** after the final failed attempt a delivery is marked `dead`. Dead and failed deliveries can be replayed from the dashboard (Settings → Webhook Deliveries).
- **Idempotency:** each delivery carries a stable id. The same logical event is not enqueued twice, so a receiver can safely deduplicate on the event id.
- **Timeout:** each attempt times out after `WEBHOOK_REQUEST_TIMEOUT_MS` (default 10s).

## Verifying webhook signatures

When a signing secret is configured for a webhook, LogTide signs each delivery so you can verify it came from LogTide and was not tampered with:

- `X-Logtide-Timestamp: <unix seconds>`
- `X-Logtide-Signature: t=<unix>,v1=<hex hmac>`

The signature is `HMAC-SHA256(secret, "<timestamp>.<raw request body>")`, hex-encoded.

```js
import crypto from 'crypto';

function verify(secret, headers, rawBody) {
  const ts = headers['x-logtide-timestamp'];
  const sig = headers['x-logtide-signature'].split('v1=')[1];
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Verify against the **raw** request body (before JSON parsing), since any reserialization can change the bytes and break the signature. Reject deliveries whose timestamp is older than your tolerance (e.g. 5 minutes) to prevent replay.

## SSRF protection

Outbound targets are resolved and validated before each request; loopback, private, link-local (including cloud metadata), CGNAT, multicast, and reserved IPv4/IPv6 ranges are rejected, and every redirect hop is revalidated. Self-hosted deployments that need to reach internal endpoints can opt in with `MONITOR_ALLOW_PRIVATE_TARGETS=true`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `WEBHOOK_MAX_ATTEMPTS` | `5` | Maximum delivery attempts before the dead-letter queue. |
| `WEBHOOK_PER_ORG_CONCURRENCY` | `5` | Concurrent deliveries per organization. |
| `WEBHOOK_GLOBAL_CONCURRENCY` | `50` | Concurrent deliveries across all organizations. |
| `WEBHOOK_DELIVERY_LOG_LIMIT` | `1000` | Attempts retained per delivery in the delivery log. |
| `WEBHOOK_REQUEST_TIMEOUT_MS` | `10000` | Per-attempt request timeout in milliseconds. |
| `MONITOR_ALLOW_PRIVATE_TARGETS` | `false` | Allow delivery to private/internal addresses (self-hosted). |
