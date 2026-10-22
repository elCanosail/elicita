import type { ElicitaApiConfig, FetchOptions } from './types.js';

export class ElicitaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'ElicitaApiError';
  }
}

function buildQueryString(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    searchParams.set(key, String(value));
  }
  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}

export async function fetchElicita(
  config: ElicitaApiConfig,
  path: string,
  params: Record<string, unknown> = {},
  options: FetchOptions = {}
): Promise<unknown> {
  let effectivePath = path;
  if (!config.apiKey && path.startsWith('/api/v1/')) {
    effectivePath = path.replace('/api/v1/', '/api/public/');
  }

  const url = `${config.baseUrl}${effectivePath}${buildQueryString(params)}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...(options.body ? { 'Content-Type': 'application/json' } : {})
  };

  if (config.clientIp) {
    headers['X-Forwarded-For'] = config.clientIp;
  }

  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000)
  };

  if (options.body) {
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ElicitaApiError('No se pudo conectar con la API de Elicita', 0);
  }

  if (!response.ok) {
    await response.body?.cancel();
    // Never reflect upstream bodies: they can contain credentials or internal details.
    throw new ElicitaApiError(`Error de la API de Elicita (${response.status})`, response.status);
  }

  try {
    return await response.json();
  } catch {
    throw new ElicitaApiError('Respuesta JSON inválida de la API de Elicita', 502);
  }
}

/**
 * Like `fetchElicita` but returns upstream wall-clock duration.
 * Useful for observability: separate upstream latency from MCP
 * processing overhead.
 *
 * Returns { data, upstreamMs } on success.
 * On error throws ElicitaApiError with an added `upstreamMs` property.
 */
export async function fetchElicitaTiming(
  config: ElicitaApiConfig,
  path: string,
  params: Record<string, unknown> = {},
  options: FetchOptions = {}
): Promise<{ data: unknown; upstreamMs: number }> {
  const start = performance.now();
  try {
    const data = await fetchElicita(config, path, params, options);
    return { data, upstreamMs: performance.now() - start };
  } catch (err) {
    const elapsed = performance.now() - start;
    if (err instanceof ElicitaApiError) {
      Object.assign(err, { upstreamMs: elapsed, upstreamStatus: err.status });
    }
    throw err;
  }
}
