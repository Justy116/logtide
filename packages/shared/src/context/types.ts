import type { ApiKeyType } from '../constants/log-constants.js';

export type ActorType = 'user' | 'apiKey' | 'system';

export interface Actor {
  readonly type: ActorType;
  readonly id: string | null;
  readonly email?: string;
  readonly apiKeyType?: ApiKeyType;
}

export type Origin = 'http' | 'job' | 'system';

export interface RequestContext {
  readonly requestId: string;
  readonly origin: Origin;
  readonly actor: Actor;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly systemReason?: string;
}

export interface SerializedContext {
  v: 1;
  requestId: string;
  origin: Origin;
  actor: Actor;
  organizationId: string | null;
  projectId: string | null;
  ip?: string;
  userAgent?: string;
  systemReason?: string;
}

export const SERIALIZED_CONTEXT_VERSION = 1 as const;
