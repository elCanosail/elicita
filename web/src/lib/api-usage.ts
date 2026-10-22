/**
 * API usage tracking and rate limiting
 *
 * - Monthly/daily usage counters are persisted in DuckDB.
 * - Token-bucket rate limiting remains in-memory (acceptable to reset on restart).
 */
import { queryWrite } from './duckdb-write';

export interface UsageRecord {
  userId: string;
  month: string; // YYYY-MM
  queriesUsed: number;
  queriesLimit: number;
  lastUpdated: number;
}

// --- Índices únicos que el UPSERT/consumo atómico necesitan (tarea 37) ---
// Producción creó api_usage_daily/monthly SIN restricción única: el
// `ON CONFLICT (user_id, date)` de los incrementos fallaba en CADA escritura
// (Binder Error verificado 2026-10-14 en scratch y contra el DDL real — tablas
// sin constraints, 0/1 filas, sin duplicados → el índice es seguro). Patrón
// idempotente una vez por proceso, como las tablas de alertas en duckdb.ts.
let usageTablesReady: Promise<void> | null = null;
function ensureUsageTables(): Promise<void> {
  if (!usageTablesReady) {
    usageTablesReady = (async () => {
      try {
        await queryWrite(
          'CREATE UNIQUE INDEX IF NOT EXISTS uidx_api_usage_daily ON api_usage_daily(user_id, date)'
        );
        await queryWrite(
          'CREATE UNIQUE INDEX IF NOT EXISTS uidx_api_usage_monthly ON api_usage_monthly(user_id, month)'
        );
      } catch (err: any) {
        usageTablesReady = null; // reintento en la siguiente llamada
        console.error('[api-usage] ensure índices únicos:', err?.message);
        throw err;
      }
    })();
  }
  return usageTablesReady;
}

// Token bucket state (in-memory, short-lived)
interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

/**
 * Get current month's key for a user
 */
function getMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getCacheKey(userId: string): string {
  return `${userId}:${getMonthKey()}`;
}

/**
 * Check if user has query budget remaining
 */
export async function checkQueryBudget(
  userId: string,
  queriesLimit: number
): Promise<{ allowed: boolean; remaining: number }> {
  const month = getMonthKey();
  const rows = await queryWrite(
    `SELECT queries_used FROM api_usage_monthly WHERE user_id = ? AND month = ?`,
    [userId, month]
  );
  const queriesUsed = rows[0]?.queries_used || 0;
  const remaining = Math.max(0, queriesLimit - queriesUsed);
  return { allowed: remaining > 0, remaining };
}

/**
 * Increment query count using DuckDB UPSERT
 */
export async function incrementQueryCount(userId: string): Promise<void> {
  await ensureUsageTables();
  const month = getMonthKey();
  const sql = `
      INSERT INTO api_usage_monthly (user_id, month, queries_used, last_updated)
      VALUES (?, ?, 1, NOW())
      ON CONFLICT (user_id, month)
      DO UPDATE SET queries_used = queries_used + 1, last_updated = NOW()
    `;
  await queryWrite(sql, [userId, month]);
}

/**
 * Check rate limit (token bucket)
 */
export function checkRateLimit(
  userId: string,
  maxTokens: number,
  refillRate: number
): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now() / 1000; // seconds
  const bucket = rateLimitBuckets.get(userId);

  if (!bucket) {
    // New bucket
    rateLimitBuckets.set(userId, {
      tokens: maxTokens - 1,
      lastRefill: now,
    });
    return { allowed: true, remaining: maxTokens - 1, resetTime: now + 60 };
  }

  // Refill tokens based on time elapsed
  const elapsed = now - bucket.lastRefill;
  const tokensToAdd = elapsed * refillRate;
  bucket.tokens = Math.min(maxTokens, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      resetTime: now + (1 / refillRate),
    };
  }

  return {
    allowed: false,
    remaining: 0,
    resetTime: bucket.lastRefill + (1 / refillRate),
  };
}

/**
 * Daily search limit for free-tier users
 * Keyed by userId + date, resets at midnight UTC
 */

const FREE_SEARCHES_PER_DAY = 3;

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Consume una búsqueda del cupo diario free de forma ATÓMICA (tarea 37).
 *
 * Sustituye al par check-then-act (checkDailySearchLimit al entrar → búsqueda
 * → incrementDailySearchCount al salir): 6 peticiones simultáneas leían todas
 * search_count=0 y pasaban — escape documentado en propuestas-2026-10-13-1600
 * (B). El consumo ahora es UN statement UPSERT con guard
 * `WHERE search_count < límite` + RETURNING: DuckDB serializa los statements
 * de una conexión y cada statement es atómico (MVCC por statement), así que la
 * carrera desaparece (test de regresión en __tests__/api-usage.test.ts).
 *
 * Cambio de semántica aceptado y documentado: el cupo se consume al ENTRAR —
 * una búsqueda que falle tras el consumo lo gasta (antes: fallaba después de
 * calcular resultados y ADEMÁS el UPSERT lanzaba Binder Error por falta de
 * índice único → 500 en cada búsqueda free; doble bug cerrado).
 *
 * Returns { allowed, remaining, limit }
 */
export async function consumeDailySearch(
  userId: string
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  await ensureUsageTables();
  const date = getTodayKey();
  const rows = await queryWrite(
    `INSERT INTO api_usage_daily (user_id, date, search_count)
     VALUES (?, ?, 1)
     ON CONFLICT (user_id, date)
     DO UPDATE SET search_count = api_usage_daily.search_count + 1
     WHERE api_usage_daily.search_count < ${FREE_SEARCHES_PER_DAY}
     RETURNING search_count`,
    [userId, date]
  );
  if (!rows || rows.length === 0) {
    // Conflicto con guard incumplido: cupo agotado (0 filas de RETURNING).
    return { allowed: false, remaining: 0, limit: FREE_SEARCHES_PER_DAY };
  }
  const count = Number(rows[0].search_count);
  return {
    allowed: true,
    remaining: Math.max(0, FREE_SEARCHES_PER_DAY - count),
    limit: FREE_SEARCHES_PER_DAY,
  };
}

/**
 * Get usage stats for dashboard
 */
export async function getUsageStats(userId: string): Promise<{
  queriesUsed: number;
  queriesLimit: number;
  queriesRemaining: number;
  month: string;
}> {
  const month = getMonthKey();
  const rows = await queryWrite(
    `SELECT queries_used FROM api_usage_monthly WHERE user_id = ? AND month = ?`,
    [userId, month]
  );
  const queriesUsed = rows[0]?.queries_used || 0;

  // queriesLimit is not persisted; default to 0 for dashboard rendering
  const queriesLimit = 0;

  return {
    queriesUsed,
    queriesLimit,
    queriesRemaining: Math.max(0, queriesLimit - queriesUsed),
    month,
  };
}
