/**
 * Rate limit compartido para los endpoints públicos sin auth.
 *
 * Semántica extraída de public/search.ts: IP de CF-Connecting-IP (no
 * falsificable tras Cloudflare; fallbacks x-real-ip → XFF → unknown), ventana
 * fija en memoria por IP+endpoint, contador que arranca en `limit` y se agota
 * sin rellenar dentro de la ventana, reset en el borde de ventana.
 *
 * Límites generosos y documentados en docs/api — el objetivo es cortar
 * abusos (Crawler/DoS sobre DuckDB), no integrantes legítimos.
 */

export interface RateOptions {
  /** Identificador del endpoint dentro de la clave de bucket. */
  name: string;
  /** Peticiones permitidas por ventana. */
  limit: number;
  /** Tamaño de ventana en ms (60_000 = por minuto; 86_400_000 = por día UTC). */
  windowMs: number;
}

export interface RateResult {
  allowed: boolean;
  remaining: number;
  /** Época (segundos) en la que la ventana se reinicia. */
  resetTime: number;
}

interface IpBucket {
  tokens: number;
  windowIndex: number;
  windowMs: number;
}

// Buckets en memoria: un proceso por instancia, el reinicio las limpia.
// Poda las ventanas caducadas al superar el tope para que un flood no crezca
// el mapa sin límite.
const buckets = new Map<string, IpBucket>();
const MAX_BUCKETS = 20_000;

export function getClientIp(request: Request): string {
  // Detrás de Cloudflare: CF-Connecting-IP es la IP real del cliente (no falsificable)
  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();
  // Detrás de nginx: x-real-ip la fija nuestra config
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  // Fallback: primera entrada de XFF (menos fiable, pero mejor que 'unknown')
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    return xff.split(',')[0]?.trim() || 'unknown';
  }
  return 'unknown';
}

function sweepExpired(nowMs: number): void {
  for (const [key, bucket] of buckets) {
    const currentIndex = Math.floor(nowMs / bucket.windowMs);
    if (bucket.windowIndex < currentIndex) buckets.delete(key);
  }
}

export function checkRateLimit(request: Request, opts: RateOptions): RateResult {
  const ip = getClientIp(request);
  const now = Date.now();
  const windowIndex = Math.floor(now / opts.windowMs);
  const resetTime = ((windowIndex + 1) * opts.windowMs) / 1000;
  const key = `${opts.name}:${ip}:${windowIndex}`;

  if (buckets.size >= MAX_BUCKETS) sweepExpired(now);
  let bucket = buckets.get(key);
  if (!bucket) {
    buckets.set(key, { tokens: opts.limit - 1, windowIndex, windowMs: opts.windowMs });
    return { allowed: true, remaining: opts.limit - 1, resetTime };
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, remaining: bucket.tokens, resetTime };
  }

  return { allowed: false, remaining: 0, resetTime };
}

/** Devuelve la respuesta 429 si el límite está agotado, o null si la petición puede continuar. */
export function rateLimitGuard(request: Request, opts: RateOptions): Response | null {
  const rate = checkRateLimit(request, opts);
  if (rate.allowed) return null;

  const retryAfter = Math.max(1, Math.ceil(rate.resetTime - Date.now() / 1000));
  return new Response(
    JSON.stringify({
      error: 'Too many requests',
      code: 'rate_limit_exceeded',
      retry_after_seconds: retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(opts.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil(rate.resetTime)),
      },
    },
  );
}
