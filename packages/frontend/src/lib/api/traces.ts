import { getApiBaseUrl } from '$lib/config';
import { getAuthToken } from '$lib/utils/auth';
import { requestStreamTicket } from './stream-tickets';

export interface TraceRecord {
  trace_id: string;
  service_name: string;
  root_service_name: string | null;
  root_operation_name: string | null;
  start_time: string;
  end_time: string;
  duration_ms: number;
  span_count: number;
  error: boolean;
}

export interface SpanRecord {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  service_name: string;
  operation_name: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  kind: 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER' | null;
  status_code: 'UNSET' | 'OK' | 'ERROR' | null;
  status_message: string | null;
  attributes: Record<string, unknown> | null;
  events: Array<Record<string, unknown>> | null;
  links: Array<Record<string, unknown>> | null;
  resource_attributes: Record<string, unknown> | null;
}

export interface TracesResponse {
  traces: TraceRecord[];
  total: number;
}

export interface TraceFilters {
  projectId: string | string[];
  service?: string | string[];
  error?: boolean;
  from?: string;
  to?: string;
  minDurationMs?: number;
  maxDurationMs?: number;
  limit?: number;
  offset?: number;
}

export interface TraceStats {
  total_traces: number;
  total_spans: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  error_count: number;
  error_rate: number;
}

export interface ServiceDependencyNode {
  id: string;
  name: string;
  callCount: number;
}

export interface ServiceDependencyEdge {
  source: string;
  target: string;
  callCount: number;
}

export interface ServiceDependencies {
  nodes: ServiceDependencyNode[];
  edges: ServiceDependencyEdge[];
}

// Enriched types for the service map page
export interface EnrichedServiceDependencyNode {
  id: string;
  name: string;
  callCount: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number | null;
  totalCalls: number;
}

export interface EnrichedServiceDependencyEdge {
  source: string;
  target: string;
  callCount: number;
  type: 'span' | 'log_correlation';
}

export interface EnrichedServiceDependencies {
  nodes: EnrichedServiceDependencyNode[];
  edges: EnrichedServiceDependencyEdge[];
}


export class TracesAPI {
  constructor(private getToken: () => string | null) {}

  private getHeaders(): HeadersInit {
    const token = this.getToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }


  async getTraces(filters: TraceFilters): Promise<TracesResponse> {
    const params = new URLSearchParams();

    const projectIds = Array.isArray(filters.projectId) ? filters.projectId : [filters.projectId];
    params.append('projectId', projectIds.join(','));
    if (filters.service) {
      const services = Array.isArray(filters.service) ? filters.service : [filters.service];
      if (services.length > 0) params.append('service', services.join(','));
    }
    if (filters.error !== undefined) params.append('error', String(filters.error));
    if (filters.from) params.append('from', filters.from);
    if (filters.to) params.append('to', filters.to);
    if (filters.minDurationMs != null) params.append('minDurationMs', filters.minDurationMs.toString());
    if (filters.maxDurationMs != null) params.append('maxDurationMs', filters.maxDurationMs.toString());
    if (filters.limit) params.append('limit', filters.limit.toString());
    if (filters.offset != null) params.append('offset', filters.offset.toString());

    const url = `${getApiBaseUrl()}/traces?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch traces: ${response.statusText}`);
    }

    return response.json();
  }

  async getTrace(traceId: string, projectId: string): Promise<TraceRecord> {
    const params = new URLSearchParams();
    params.append('projectId', projectId);

    const url = `${getApiBaseUrl()}/traces/${traceId}?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch trace: ${response.statusText}`);
    }

    return response.json();
  }

  async getTraceSpans(traceId: string, projectId: string): Promise<SpanRecord[]> {
    const params = new URLSearchParams();
    params.append('projectId', projectId);

    const url = `${getApiBaseUrl()}/traces/${traceId}/spans?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch trace spans: ${response.statusText}`);
    }

    const data = await response.json();
    return data.spans;
  }

  async getServices(projectId: string): Promise<string[]> {
    const params = new URLSearchParams();
    params.append('projectId', projectId);

    const url = `${getApiBaseUrl()}/traces/services?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch services: ${response.statusText}`);
    }

    const data = await response.json();
    return data.services;
  }

  async getStats(projectId: string, from?: string, to?: string): Promise<TraceStats> {
    const params = new URLSearchParams();
    params.append('projectId', projectId);
    if (from) params.append('from', from);
    if (to) params.append('to', to);

    const url = `${getApiBaseUrl()}/traces/stats?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch trace stats: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Open an SSE stream that emits new traces as they arrive. Filters match
   * the traces query (projectId, service, error). Returns an EventSource the
   * caller is responsible for closing.
   */
  async createTracesEventSource(filters: {
    projectId: string;
    service?: string | string[];
    error?: boolean;
  }): Promise<EventSource> {
    const params = new URLSearchParams();
    params.append('projectId', filters.projectId);
    if (filters.service) {
      const services = Array.isArray(filters.service) ? filters.service : [filters.service];
      if (services.length > 0) params.append('service', services.join(','));
    }
    if (filters.error !== undefined) params.append('error', String(filters.error));
    // Use a short-lived single-use ticket instead of the session token so the
    // token never appears in the SSE URL (and thus in proxy/server logs).
    const ticket = await requestStreamTicket(this.getToken());
    params.append('ticket', ticket);
    const url = `${getApiBaseUrl()}/traces/stream?${params.toString()}`;
    return new EventSource(url, { withCredentials: true });
  }

  async getServiceMap(projectId: string, from?: string, to?: string): Promise<EnrichedServiceDependencies> {
    const params = new URLSearchParams();
    params.append('projectId', projectId);
    if (from) params.append('from', from);
    if (to) params.append('to', to);

    const url = `${getApiBaseUrl()}/traces/service-map?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch service map: ${response.statusText}`);
    }

    return response.json();
  }

  async getDependencies(projectId: string, from?: string, to?: string): Promise<ServiceDependencies> {
    const params = new URLSearchParams();
    params.append('projectId', projectId);
    if (from) params.append('from', from);
    if (to) params.append('to', to);

    const url = `${getApiBaseUrl()}/traces/dependencies?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch service dependencies: ${response.statusText}`);
    }

    return response.json();
  }
}

export const tracesAPI = new TracesAPI(getAuthToken);
