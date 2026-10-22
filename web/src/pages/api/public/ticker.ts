/**
 * GET /api/public/ticker — las licitaciones adjudicadas más recientes con importe significativo.
 * Sin auth. Rate limit compartido: 60 req/min por IP (lib/rate-limit.ts).
 * Cache 10 min (los datos se materializan cada 4h); s-maxage para el edge de CF.
 * Orden: fecha_publicacion DESC (excluye fechas futuras corruptas), limit 20.
 * Contrato: sin `fuente` — el SELECT traía id_plataforma y el mapeo leía una
 * columna inexistente (devolvía siempre ""); ver lib/ticker.ts.
 */
export const prerender = false;
import type { APIRoute } from 'astro';
import { query } from '../../../lib/duckdb';
import { statSync } from 'node:fs';
import { rateLimitGuard } from '../../../lib/rate-limit';
import { mapTickerRow } from '../../../lib/ticker';
import { cached } from '../../../lib/cache';

// Memo de origen (lib/cache): CF no cachea JSON (cf-cache-status DYNAMIC verificado
// el 08-10) — 1 cómputo/min por proceso; el dato se materializa cada 4h.
const TICKER_CACHE_TTL_MS = 60_000;

export const GET: APIRoute = async ({ request }) => {
  const limited = rateLimitGuard(request, { name: 'public-ticker', limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const payload = await cached('public:ticker:v1', TICKER_CACHE_TTL_MS, async () => {
      const rows = await query(
        `SELECT expediente, organo_contratante, adjudicatario,
              importe_adjudicacion, fecha_publicacion
       FROM calidad
       WHERE importe_adjudicacion > 100000
         AND fecha_publicacion IS NOT NULL
         AND fecha_publicacion <= CURRENT_DATE
       ORDER BY fecha_publicacion DESC, importe_adjudicacion DESC
       LIMIT 20`
      );

      // Frescura: el mtime del DuckDB de producción (la última materialización)
      let lastUpdated: string | null = null;
      try {
        lastUpdated = statSync('/var/data/licitaciones/db/licitaciones.duckdb').mtime.toISOString();
      } catch { /* el mtime: best-effort */ }

      return {
        data: rows.map((r: any) => mapTickerRow(r)),
        last_updated: lastUpdated,
      };
    });

    return new Response(
      JSON.stringify(payload),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600, s-maxage=600' } },
    );
  } catch (e) {
    console.error('[ticker] error:', e instanceof Error ? e.message : String(e));
    return new Response(
      JSON.stringify({ data: [], last_updated: null, error: 'ticker unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
