/**
 * GET /api/graph-public/featured
 * Devuelve una entidad relevante aleatoria (adjudicatario o organismo) con volumen alto.
 * 50% probabilidad de cada tipo. Usado por la home para rotar el grafo en cada carga.
 * Sin auth. Cacheado 1h.
 */
import type { APIRoute } from 'astro';
import { query } from '../../../lib/duckdb';
import { rateLimitGuard } from '../../../lib/rate-limit';
import { cachedResponse } from '../../../lib/cache';

// Memo de origen (lib/cache): SOLO el modo sector (determinista) se cachea —
// la rotación aleatoria de portada se preserva sin caché.
const GRAPH_FEATURED_CACHE_TTL_MS = 300_000;

function toStr(v: any): string {
  if (typeof v === 'bigint') return String(v);
  return String(v || '');
}
function toNum(v: any): number {
  if (typeof v === 'bigint') return Number(v);
  return Number(v) || 0;
}

export const GET: APIRoute = async ({ request, url }) => {
  const limited = rateLimitGuard(request, { name: 'public-graph-featured', limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    // Sector preset mode: with a cpv param (comma-separated division prefixes,
    // e.g. "48,72"), return the DETERMINISTIC top organismo for that sector so
    // sector views always open on the same buyer. Without cpv, keep the random
    // featured rotation for the home.
    const cpvRaw = url.searchParams.get('cpv')?.trim() || '';
    const cpvCodes = cpvRaw
      .split(',')
      .map((c) => c.replace(/[^0-9]/g, ''))
      .filter((c) => c.length >= 2)
      .slice(0, 6);
    const cpvFilter = cpvCodes.length
      ? ` AND (${cpvCodes.map(() => `cpv LIKE ?`).join(' OR ')})`
      : '';
    const cpvParams = cpvCodes.map((c) => `${c}%`);

    // Modo sector (determinista): top organismo del sector, 1 cómputo por sector
    // y TTL (lib/cache). La rotación aleatoria de portada NO se cachea.
    if (cpvCodes.length > 0) {
      return cachedResponse(
        `public:graph-featured:v1:${cpvCodes.join(',')}`,
        GRAPH_FEATURED_CACHE_TTL_MS,
        async () => {
          const rows = await query(
            `SELECT
          organismo as nombre,
          COUNT(*) as contratos,
          SUM(importe_adjudicacion) as volumen
         FROM contratos_vivos
         WHERE organismo IS NOT NULL
           AND organismo != ''
           AND importe_adjudicacion > 0${cpvFilter}
         GROUP BY organismo
         HAVING COUNT(*) >= 1
         ORDER BY contratos DESC, volumen DESC
         LIMIT 1`,
            cpvParams
          );

          if (rows.length) {
            const pick = rows[0];
            return new Response(
              JSON.stringify({
                type: 'organismo',
                id: toStr(pick.nombre),
                nombre: toStr(pick.nombre),
                contratos: toNum(pick.contratos),
                volumen: toNum(pick.volumen),
              }),
              {
                status: 200,
                headers: {
                  'Content-Type': 'application/json',
                  'Cache-Control': 'public, max-age=3600, s-maxage=3600',
                },
              }
            );
          }
          return new Response(JSON.stringify({ error: 'Sin organismos para el sector' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      );
    }

    // 50% adjudicatario, 50% organismo (random mode only)
    const showOrganismo = cpvCodes.length > 0 || Math.random() < 0.5;

    if (showOrganismo) {
      // Top 50 organismos por volumen de contratos
      const rows = await query(
        `SELECT
          organismo as nombre,
          COUNT(*) as contratos,
          SUM(importe_adjudicacion) as volumen
         FROM contratos_vivos
         WHERE organismo IS NOT NULL
           AND organismo != ''
           AND importe_adjudicacion > 0${cpvFilter}
         GROUP BY organismo
         HAVING COUNT(*) >= ${cpvCodes.length ? 1 : 100}
         ORDER BY contratos DESC, volumen DESC
         LIMIT ${cpvCodes.length ? 1 : 50}`,
        cpvCodes.length ? cpvParams : []
      );

      if (rows.length) {
        const pick = rows[Math.floor(Math.random() * rows.length)];
        return new Response(JSON.stringify({
          type: 'organismo',
          id: toStr(pick.nombre),
          nombre: toStr(pick.nombre),
          contratos: toNum(pick.contratos),
          volumen: toNum(pick.volumen),
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600, s-maxage=3600',
          },
        });
      }
    }

    // Adjudicatarios (fallback si el modo aleatorio cayó en organismo sin filas).
    // El modo sector ya retornó arriba: sin organismos para el sector → 404;
    // devolver una entidad de otro sector rompería la vista.

    const rows = await query(
      `SELECT
        nif_adjudicatario as nif,
        adjudicatario as nombre,
        COUNT(*) as contratos,
        SUM(importe_adjudicacion) as volumen
       FROM contratos_vivos
       WHERE nif_adjudicatario IS NOT NULL
         AND nif_adjudicatario != ''
         AND adjudicatario IS NOT NULL
         AND adjudicatario != ''
         AND importe_adjudicacion > 0
       GROUP BY nif_adjudicatario, adjudicatario
       HAVING COUNT(*) >= 50
       ORDER BY volumen DESC
       LIMIT 50`
    );

    if (!rows.length) {
      return new Response(JSON.stringify({ error: 'No hay datos' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const pick = rows[Math.floor(Math.random() * rows.length)];
    return new Response(JSON.stringify({
      type: 'adjudicatario',
      id: toStr(pick.nif),
      nif: toStr(pick.nif),
      nombre: toStr(pick.nombre),
      contratos: toNum(pick.contratos),
      volumen: toNum(pick.volumen),
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  } catch (err: any) {
    console.error('[graph-public/featured] Error:', err.message);
    return new Response(JSON.stringify({ error: 'Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};