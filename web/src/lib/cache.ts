/**
 * Memo en proceso con TTL y mapa acotado — patrón generalizado de api/stats.ts.
 *
 * ¿Por qué? CF no cachea los JSON de la API (cf-cache-status: DYNAMIC verificado
 * el 08-10 pese a s-maxage=600): cada petición de cualquier IP llega a DuckDB o
 * al disco. El rate limit protege por-IP; una tormenta multi-IP no tiene más
 * freno que el origen. Este memo acota el coste del origen a 1 cómputo por
 * clave y TTL (los datos públicos se materializan cada 4h → TTLs cortos sin
 * riesgo de frescura perceptible).
 *
 * - LRU acotado (maxEntries): las claves incluyen params de usuario (q, cpv);
 *   el mapa no crece sin límite aunque roten claves distintas.
 * - cachedResponse() solo cachea 2xx: los errores transitorios (404/429/500/503)
 *   pasan sin fijarse — un fallo puntual no se congela por TTL.
 * - Sin single-flight: dos misses concurrentes computan dos veces (igual que
 *   stats.ts). Inofensivo: el cómputo es idempotente y el rate limit sigue activo.
 * - El valor `undefined` no es cacheable (indistinguible de un miss); los
 *   endpoints devuelven objetos/arrays, nunca undefined.
 *
 * Tarea 40 (escudo SSR): createMemoCache(maxEntries) crea instancias
 * independientes con capacidad propia para las rutas HTML SSR de datos, cuyo
 * espacio de claves (618K fichas) desborda la LRU fija de 128:
 *   - ficha /licitacion: fila por fuente|id  — LRU 10.000, TTL 600s
 *   - perfil /perfil:    agregados por nif   — LRU 500,    TTL 300s
 *   - licitaciones/ccaa: listado por ccaa    — LRU 32,     TTL 300s
 * En el nivel de DATOS (cached), la guarda de errores es natural: una fn que
 * lanza (p. ej. fallo DuckDB) propaga y NO se cachea — igual que solo-2xx.
 */

interface Entry {
  value: unknown;
  expires: number;
}

const DEFAULT_MAX_ENTRIES = 128;

class MemoCache {
  private store = new Map<string, Entry>();
  readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get<T = unknown>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    // LRU: reinsertar para refrescar la recencia (Map conserva el orden de inserción)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

const defaultCache = new MemoCache(DEFAULT_MAX_ENTRIES);

export function cacheGet<T = unknown>(key: string): T | undefined {
  return defaultCache.get<T>(key);
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  defaultCache.set(key, value, ttlMs);
}

async function cachedIn<T>(
  cache: MemoCache,
  key: string,
  ttlMs: number,
  fn: () => Promise<T> | T
): Promise<T> {
  const hit = cache.get<T>(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  cache.set(key, value, ttlMs);
  return value;
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T> | T): Promise<T> {
  return cachedIn(defaultCache, key, ttlMs, fn);
}

/**
 * Memoiza la respuesta JSON de un endpoint de lectura (solo 2xx).
 * El body se almacena como texto: las respuestas servidas desde caché son
 * byte-idénticas a las computadas (mismo status y cabeceras).
 */
export async function cachedResponse(
  key: string,
  ttlMs: number,
  fn: () => Promise<Response>
): Promise<Response> {
  const hit = defaultCache.get<{ status: number; body: string; headers: Record<string, string> }>(key);
  if (hit) return new Response(hit.body, { status: hit.status, headers: hit.headers });
  const res = await fn();
  if (res.status < 200 || res.status >= 300) return res;
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = await res.text();
  defaultCache.set(key, { status: res.status, body, headers }, ttlMs);
  return new Response(body, { status: res.status, headers });
}

/**
 * Instancia independiente con capacidad propia (tarea 40): mismo comportamiento
 * LRU/TTL que el store por defecto, evicción a su propio maxEntries y claves
 * aisladas de las demás instancias. Para cachear DATOS de rutas SSR (no HTML:
 * el render sigue siendo por petición).
 */
export function createMemoCache(maxEntries: number) {
  const cache = new MemoCache(maxEntries);
  return {
    get: <T = unknown>(key: string): T | undefined => cache.get<T>(key),
    set: (key: string, value: unknown, ttlMs: number): void => cache.set(key, value, ttlMs),
    cached: <T>(key: string, ttlMs: number, fn: () => Promise<T> | T): Promise<T> =>
      cachedIn(cache, key, ttlMs, fn),
    /** Nº de entradas vivas (tests/observabilidad). */
    size: (): number => cache.size,
    clear: (): void => cache.clear(),
  };
}

/** Solo para tests. */
export function cacheClear(): void {
  defaultCache.clear();
}

/** Nº de entradas vivas del store por defecto (tests/observabilidad). */
export function cacheSize(): number {
  return defaultCache.size;
}
