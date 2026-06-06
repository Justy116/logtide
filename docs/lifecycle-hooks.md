# Lifecycle Hooks

Contract reference for operators and downstream distributions. Last updated 2026-06-06 (#216).

---

## What hooks are (and are not)

Lifecycle hooks are a small, intentional set of four named extension points inside the backend. They are not a general event bus, not an async event emitter, and not a plugin system. Each phase is a specific moment in a specific code path where a registered handler may observe, mutate, or reject an operation.

Nothing is registered by default. In an OSS deployment with no external modules and no downstream bootstrap code, `hasHandlers` returns false for every phase, and the hook path is skipped entirely. There is no overhead.

| Phase | When it runs | Code path |
|---|---|---|
| `beforeIngest` | After auth, PII masking and quota checks; after records are converted to reservoir format; immediately before `reservoir.ingestReturning`. | `IngestionService.ingestLogs` in `modules/ingestion/service.ts`. Covers both HTTP ingest (`POST /api/v1/logs`) and OTLP log ingestion, since both go through this method. |
| `beforeQuery` | At the top of `QueryService.queryLogs`, after request parsing and access checks in the route, before the cache key is built. | `QueryService.queryLogs` in `modules/query/service.ts`. Covers only the main log query path; stats, histogram, trace and context endpoints are not covered in v1 (see limitations). |
| `beforeAlertEvaluation` | Once per rule, inside the alert evaluation loop, before `checkRule` is called. | `AlertsService.checkAlertRules` in `modules/alerts/service.ts`. |
| `beforeWebhookDispatch` | Immediately before the outbound `safeFetch` call, after headers and payload are fully assembled. | `WebhookProvider.send` in `modules/notification-channels/providers/webhook-provider.ts` (notification channel path) AND `sendWebhookNotification` in `queue/jobs/alert-notification.ts` (legacy alert-rule `webhook_url` path). Both paths are covered. |

---

## Context contract per phase

These interfaces are the source of truth. Handlers must not mutate fields marked `readonly`.

### `BeforeIngestContext`

```ts
export interface BeforeIngestContext {
  readonly organizationId: string | null;
  readonly projectId: string;
  /** Record count before hooks ran (snapshot; not recomputed after mutation). */
  readonly eventCount: number;
  /** Serialized-size estimate in bytes, computed only when handlers exist. */
  readonly byteSize: number;
  /** MUTABLE: filter/redact/modify entries, or assign a new array. */
  records: IngestLogRecord[];
}
```

| Field | Status | Notes |
|---|---|---|
| `organizationId` | STABLE-READONLY | Null when the project's organization cannot be resolved. |
| `projectId` | STABLE-READONLY | Always set. |
| `eventCount` | STABLE-READONLY | Snapshot taken before hooks run; not recomputed if `records` is mutated. |
| `byteSize` | STABLE-READONLY | `JSON.stringify(records)` byte length, computed only when handlers exist (zero-overhead guard). Not recomputed after mutation. |
| `records` | MUTABLE | May be filtered, redacted, reordered, or replaced with a new array. If the array is emptied, ingestion returns 0 and no downstream processing happens. If records are filtered or replaced, downstream consumers (Sigma detection, exception parsing, pipeline processing, metering, correlation) are automatically realigned with the new array so they never see phantom entries; newly created records (records with no original counterpart) are synthesized as minimal `LogInput` for downstream. |

### `BeforeQueryContext`

```ts
export interface BeforeQueryContext {
  /** From the ALS RequestContext; null on session-auth routes (org not bound). */
  readonly organizationId: string | null;
  /** Informational snapshot of params.projectId taken before hooks ran. */
  readonly projectIds: string[];
  /** MUTABLE: narrow the time range, force filters, cap limit, etc. */
  params: LogQueryParams;
}
```

| Field | Status | Notes |
|---|---|---|
| `organizationId` | STABLE-READONLY | Null on session-auth query routes where the org is not bound to the ALS context. |
| `projectIds` | STABLE-READONLY | Informational snapshot of `params.projectId` at hook entry. |
| `params` | MUTABLE | Mutations drive both the cache key and the reservoir read. Mutating `params` before the cache key is built is the intended way to force time-range caps, inject mandatory filters, or reduce the limit. |

### `BeforeAlertEvaluationContext`

```ts
export interface BeforeAlertEvaluationContext {
  readonly organizationId: string;
  readonly ruleId: string;
  readonly ruleType: 'threshold' | 'rate_of_change';
}
```

| Field | Status | Notes |
|---|---|---|
| `organizationId` | STABLE-READONLY | Always set (alert rules are org-scoped). |
| `ruleId` | STABLE-READONLY | UUID of the rule about to be evaluated. |
| `ruleType` | STABLE-READONLY | Rule kind. |

All fields are readonly. This context is informational only; there is no mutable surface. Rejection skips the rule for this evaluation cycle.

### `BeforeWebhookDispatchContext`

```ts
export interface BeforeWebhookDispatchContext {
  readonly organizationId: string | null;
  /** Set on the notification-channel path. */
  readonly channelId?: string;
  /** Set on the legacy alert-rule webhook path. */
  readonly ruleId?: string;
  /** READONLY: mutating the target would sidestep validated channel config. */
  readonly url: string;
  readonly targetHost: string;
  /** MUTABLE: e.g. inject signing/compliance headers. */
  headers: Record<string, string>;
  /** MUTABLE: redact or enrich the payload before it leaves. */
  body: Record<string, unknown>;
}
```

| Field | Status | Notes |
|---|---|---|
| `organizationId` | STABLE-READONLY | Null when the channel has no org context. |
| `channelId` | STABLE-READONLY | Present on the notification-channel path; absent on the legacy path. |
| `ruleId` | STABLE-READONLY | Present on the legacy alert-rule `webhook_url` path; absent on the channel path. |
| `url` | STABLE-READONLY | The validated webhook URL. Readonly by design: changing the target would bypass the SSRF-validated channel configuration. `safeFetch` still validates the URL against the SSRF guard regardless of what a hook does to other fields. |
| `targetHost` | STABLE-READONLY | Hostname extracted from `url`. Provided for convenience (avoids re-parsing in handlers). |
| `headers` | MUTABLE | Add, remove or replace outbound headers (e.g. HMAC signatures, compliance headers). |
| `body` | MUTABLE | Redact or enrich the JSON payload before it is sent. |

---

## Execution guarantees

Handlers registered for a phase run sequentially in registration order. The phase is not parallelized. Each handler awaits the previous one before the next starts, so a later handler sees any mutations made by an earlier one.

The first handler to throw short-circuits the phase. Subsequent handlers do not run.

`eventCount` and `byteSize` on `BeforeIngestContext` are snapshots taken before any handler runs. They are not recomputed after a handler mutates `records`.

---

## Rejection semantics

### `HookRejectionError`

```ts
export class HookRejectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 403
  ) { ... }
}
```

A handler throws `HookRejectionError` to abort the operation intentionally. The registry detects it with `instanceof HookRejectionError` and propagates it as-is; it is not wrapped. The effect depends on the phase:

| Phase | Effect of `HookRejectionError` |
|---|---|
| `beforeIngest` | Ingestion aborts. The global error handler surfaces `statusCode`, `code` and `message` in the HTTP response (same path as `CapabilityError` and `QuotaExceededError`). The client receives a machine-readable error body. |
| `beforeQuery` | The query aborts. Same HTTP error surface as above. |
| `beforeAlertEvaluation` | That rule is skipped for this evaluation cycle. The rejection is logged (`[Alerts] Rule <id> skipped by hook: <code>`). The rest of the batch continues. |
| `beforeWebhookDispatch` (channel path) | Delivery is recorded as failed. The provider returns `{ success: false, error: 'Webhook dispatch rejected: <message>' }`. No retry. |
| `beforeWebhookDispatch` (legacy path) | The rejection propagates out of `sendWebhookNotification`; the job's catch records `HookRejectionError.message` as a delivery failure string in alert history (raw message, without the channel path's `Webhook dispatch rejected:` prefix). No retry. |

### Unexpected errors (fail-closed)

Any exception that is NOT an `instanceof HookRejectionError` is caught by the registry, logged server-side with the original error, and wrapped in `HookExecutionError`:

```ts
export class HookExecutionError extends Error {
  readonly code = 'hook.execution_failed';
  readonly statusCode = 500;
  constructor(public readonly phase: HookPhase, cause?: unknown) { ... }
}
```

The original error is chained via `Error.cause` and logged on the server. The client only sees a 500 with code `hook.execution_failed`. The original error is never sent to the client.

Exception: in the alert evaluation loop, an unexpected hook error is caught at the call site. The rule is skipped and the error is logged (`[Alerts] Rule <id> skipped, hook failed: <err>`), but `HookExecutionError` is not rethrown. The batch survives.

---

## Registering hooks

### Code-level registration (downstream distributions)

Import and call `hooks.register()` in your bootstrap, before the server starts accepting requests:

```ts
import { hooks } from 'packages/backend/src/hooks/index.js';
import { HookRejectionError } from 'packages/backend/src/hooks/index.js';

hooks.register('beforeIngest', async (ctx) => {
  if (ctx.byteSize > 5 * 1024 * 1024) {
    throw new HookRejectionError('policy.batch_too_large', 'Batch exceeds 5MB', 429);
  }
});
```

This works because the distribution builds from source and can import `HookRejectionError` directly. The `instanceof` check in the registry matches, and the error surfaces as a clean 429 to the client.

### `HOOKS_MODULES` (container deployments)

Set `HOOKS_MODULES` to a comma-separated list of absolute paths to `.js` or `.mjs` files. Each file must default-export a function with the signature `(hooks: HookRegistry, helpers: HookModuleHelpers) => void | Promise<void>` (the second argument is optional for modules that only observe or mutate). The loader calls this function at boot, on both the server process and the worker process. A load failure (missing file, bad export, any error from the register function) is fatal: the process exits rather than running without the intended policy.

```
HOOKS_MODULES=/etc/logtide/hooks/policy.mjs,/etc/logtide/hooks/audit.mjs
```

The `helpers` argument carries the `HookRejectionError` class so external modules can produce clean 4xx rejections without importing backend internals. The registry's `instanceof HookRejectionError` check uses the same class reference passed through helpers, so the identity matches correctly.

Example module:

```js
// /etc/logtide/hooks/policy.mjs
export default function register(hooks, { HookRejectionError }) {
  hooks.register('beforeIngest', async (ctx) => {
    // Reject: block batches that exceed the policy limit with a clean 429
    if (ctx.byteSize > 5 * 1024 * 1024) {
      throw new HookRejectionError('policy.batch_too_large', 'Batch exceeds 5MB policy', 429);
    }
    // Observe-only: log large batches without rejecting
    if (ctx.eventCount > 10000) {
      console.warn(`[Policy] Large batch from project ${ctx.projectId}: ${ctx.eventCount} events`);
    }
    // Mutate: strip a sensitive field from all records before the reservoir write
    for (const record of ctx.records) {
      if (record.metadata) {
        delete record.metadata.internal_token;
      }
    }
  });

  hooks.register('beforeWebhookDispatch', async (ctx) => {
    // Inject a signing header
    ctx.headers['X-LogTide-Sig'] = computeHmac(ctx.body, process.env.WEBHOOK_SECRET);
  });
}
```

Throwing `HookRejectionError` from an external module surfaces a clean 4xx with a machine-readable code to the client. Any other error fails closed as HTTP 500 (`hook.execution_failed`): the operation is still blocked, but the error surfaced to the client is not the intended 4xx. Observe and mutate use cases never need to throw.

---

## Conventions

**No unbounded I/O.** Hooks run on the hot path. There is no timeout enforced in v1. Handlers must not perform unbounded network calls, uncached database reads, or any operation whose latency is uncontrolled. Keep handlers fast; add your own timeout wrapper if you need to call an external service.

**ALS RequestContext.** Hooks can read the current request context via `context.currentOrNull()` from `@logtide/shared/context`. This gives access to `organizationId`, `requestId`, `ip`, `userAgent`, and the authenticated actor. Note that `organizationId` is null on session-auth query paths (the org is not bound to the ALS context for those routes), which is why `BeforeQueryContext.organizationId` may also be null.

**Error cause.** When logging unexpected hook failures server-side, the original error is available as `err.cause` on the `HookExecutionError`. Use this when adding structured logging to hook infrastructure.

---

## v1 Limitations

- `beforeQuery` covers only `QueryService.queryLogs`. It does not intercept the stats, histogram, trace correlation or log-context endpoints.
- `eventCount` and `byteSize` on `BeforeIngestContext` are pre-hook snapshots. They are not recomputed after `records` is mutated, filtered or replaced. If you need the post-mutation count, use `ctx.records.length` directly.
- No timeout is enforced on handlers. This is intentional in v1 to avoid surprising registered handlers; it may be added in a future version with an opt-in per-handler budget.
- There is no hook for OTLP trace or metric ingestion paths in v1.
