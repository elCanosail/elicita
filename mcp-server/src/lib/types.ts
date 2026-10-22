export interface ElicitaApiConfig {
  baseUrl: string;
  apiKey: string;
  clientIp?: string;
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
}

export interface SearchParams {
  q?: string;
  cpv?: string;
  importe_min?: number;
  importe_max?: number;
  estado?: string;
  fuente?: string;
  nif?: string;
  fecha_desde?: string;
  fecha_hasta?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}

export interface GraphSearchParams {
  nif: string;
  depth?: number;
  limit?: number;
}

export interface GraphContractsParams {
  id: string;
  limit?: number;
}

export interface OrganismoParams {
  nif: string;
}

export interface CpvSearchParams {
  q: string;
  limit?: number;
}

export interface ToolResult extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** Upstream API wall-clock duration in ms (0 if no upstream call). */
  upstreamMs?: number;
  /** Internal upstream HTTP status for metric bucketing; removed before transport. */
  upstreamStatus?: number;
}
