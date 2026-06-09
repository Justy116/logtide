/**
 * Webhook dispatcher (#218).
 *
 * `deliverOnce` is the single-attempt primitive shared by the synchronous
 * notification-channel provider and the queued retry layer: it runs the
 * beforeWebhookDispatch hook, signs the body, and sends via the SSRF guard.
 * `enqueue` (added later) layers persistence + retry + DLQ on top.
 */
import { config } from '../../config/index.js';
import { safeFetch, SsrfBlockedError } from '../../utils/ssrf-guard.js';
import { hooks, HookRejectionError } from '../../hooks/index.js';
import { buildSignatureHeaders } from './signing.js';
import type { DeliverOnceParams, DeliverOnceResult } from './types.js';

const RESPONSE_EXCERPT_MAX = 500;

export async function deliverOnce(params: DeliverOnceParams): Promise<DeliverOnceResult> {
  const started = Date.now();
  const bodyString = JSON.stringify(params.body ?? {});

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'LogTide/1.0',
    ...(params.headers ?? {}),
  };
  if (params.signingSecret) {
    const unix = Math.floor(Date.now() / 1000);
    Object.assign(headers, buildSignatureHeaders(params.signingSecret, bodyString, unix));
  }

  // Lifecycle hook (#216): last interception point before the outbound call.
  if (hooks.hasHandlers('beforeWebhookDispatch')) {
    let targetHost: string;
    try {
      targetHost = new URL(params.url).hostname;
    } catch {
      return { success: false, durationMs: Date.now() - started, error: 'Invalid webhook URL', retryable: false };
    }
    try {
      await hooks.run('beforeWebhookDispatch', {
        organizationId: params.organizationId,
        channelId: params.channelId,
        ruleId: params.ruleId,
        url: params.url,
        targetHost,
        headers,
        body: params.body,
      });
    } catch (e) {
      const msg = e instanceof HookRejectionError ? `rejected: ${e.message}` : 'blocked: hook failed';
      return { success: false, durationMs: Date.now() - started, error: `Webhook dispatch ${msg}`, retryable: false };
    }
  }

  try {
    const response = await safeFetch(
      params.url,
      {
        method: 'POST',
        headers,
        body: bodyString,
        signal: AbortSignal.timeout(config.WEBHOOK_REQUEST_TIMEOUT_MS),
      },
      { allowPrivate: config.MONITOR_ALLOW_PRIVATE_TARGETS }
    );

    const durationMs = Date.now() - started;
    if (response.ok) {
      return { success: true, statusCode: response.status, durationMs, retryable: false };
    }
    const excerpt = (await response.text().catch(() => '')).slice(0, RESPONSE_EXCERPT_MAX);
    return {
      success: false,
      statusCode: response.status,
      durationMs,
      responseExcerpt: excerpt,
      error: `HTTP ${response.status} ${response.statusText}`,
      retryable: response.status >= 500 || response.status === 429,
    };
  } catch (e) {
    const durationMs = Date.now() - started;
    if (e instanceof SsrfBlockedError) {
      return {
        success: false,
        durationMs,
        error: 'Webhook URLs pointing to private/internal addresses are not allowed',
        retryable: false,
      };
    }
    // Network errors and timeouts (AbortError) are transient.
    return {
      success: false,
      durationMs,
      error: e instanceof Error ? e.message : 'Unknown error',
      retryable: true,
    };
  }
}
