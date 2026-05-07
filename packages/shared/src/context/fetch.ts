import { currentOrNull } from './storage.js';

export async function fetchWithContext(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const ctx = currentOrNull();
  if (!ctx) return fetch(input, init);

  const headers = new Headers(init?.headers);
  if (!headers.has('X-Logtide-Request-Id')) {
    headers.set('X-Logtide-Request-Id', ctx.requestId);
  }
  return fetch(input, { ...init, headers });
}
