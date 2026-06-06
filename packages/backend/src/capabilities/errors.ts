import type { CapabilityName } from './registry.js';

/**
 * Policy / static-cap denial. Maps to HTTP 403 via the global error handler
 * in server.ts (which reads `statusCode` on 4xx errors).
 */
export class CapabilityError extends Error {
  readonly statusCode = 403;
  constructor(
    public readonly code: string,
    message: string,
    public readonly capability: CapabilityName
  ) {
    super(message);
    this.name = 'CapabilityError';
  }
}

/**
 * Metered usage-quota denial. Maps to HTTP 429 (retry later / upgrade) rather
 * than 403 (forbidden). Carried by the global error handler the same way.
 */
export class QuotaExceededError extends Error {
  readonly statusCode = 429;
  constructor(
    public readonly code: string,
    message: string,
    public readonly capability: CapabilityName
  ) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}
