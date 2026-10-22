import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import { getUserPlan } from '../../lib/plan';
import { consumeDailySearch } from '../../lib/api-usage';
import { query } from '../../lib/duckdb';

/**
 * Unified search across all tables
 * Each table maps its columns to a common schema:
 *   titulo, organismo, adjudicatario, nif_adj, importe, cpv, estado, fecha, fuente
 *
 * OPTIMIZATION: Filters are pushed down into each subquery so DuckDB can
 * prune rows at scan time (columnar predicate pushdown) instead of
 * materializing the full 27M-row UNION first.
 */

/**
 * All _json tables share the same unified schema:
 *   id, fuente, expediente, organismo, objeto, cpv, cpvs,
 *   importe_licitacion, importe_adjudicacion, fecha_publicacion, fecha_fin,
 *   url, estado, adjudicatario, nif_adjudicatario
 */
/**
 * La búsqueda consulta contratos_busqueda: la tabla materializada que une la
 * ventana viva (contratos_json_saneados) con el histórico PLACSP desde 2012
 * (calidad), deduplicada por expediente|organismo. Materializada 2026-09-26
 * (5,33M filas); el materializador debe reconstruirla tras cada ciclo de
 * ingesta (y añadir índice FTS cuando el paquete duckdb soporte
 * create_fts_index sin crash — verificado: el paquete actual hace stack
 * smashing en PRAGMA create_fts_index).
 */

function sqlEscape(s: string): string {
  return String(s || '').replace(/[\\']/g, (m) => (m === "'" ? "''" : '\\\\')).replace(/[\x00-\x1f]/g, '');
}

function validYear(s: string): string | null {
  const y = String(s || '').trim();
  return /^\d{4}$/.test(y) && +y >= 2000 && +y <= 2099 ? y : null;
}

function validNumber(s: string): number | null {
  const n = parseFloat(String(s || ''));
  return isNaN(n) || n < 0 ? null : n;
}

function buildBusquedaQuery(term: string, filters: Record<string, string>) {
  const limit = Math.min(parseInt(filters.limit || '50'), 200);
  const offset = parseInt(filters.offset || '0') || 0;
  const escaped = term ? sqlEscape(term).toLowerCase() : '';

  // Sort config
  const validSortCols: Record<string, string> = {
    titulo: 'titulo', organismo: 'organismo', adjudicatario: 'adjudicatario',
    importe: 'importe', fuente: 'fuente', fecha: 'fecha',
  };
  const sortCol = validSortCols[filters.sort || ''] || 'fecha';
  const sortDir = filters.dir === 'asc' ? 'ASC' : 'DESC';
  const nullsOrder = sortDir === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';

  const where: string[] = [];

  // Text search across titulo, organismo, adjudicatario
  if (escaped) {
    where.push(`(contains(lower(objeto), '${escaped}') OR contains(lower(organismo), '${escaped}') OR contains(lower(adjudicatario), '${escaped}'))`);
  }

  // CPV
  if (filters.cpv) {
    const cpv = sqlEscape(filters.cpv);
    where.push(`cpv LIKE '${cpv}%'`);
  }

  // Importe
  const impMin = validNumber(filters.importeMin);
  const impMax = validNumber(filters.importeMax);
  if (impMin !== null) {
    where.push(`COALESCE(importe_adjudicacion, importe_licitacion) >= ${impMin}`);
  }
  if (impMax !== null) {
    where.push(`COALESCE(importe_adjudicacion, importe_licitacion) <= ${impMax}`);
  }

  // Estado
  if (filters.estado) {
    const estado = sqlEscape(filters.estado);
    where.push(`estado ILIKE '%${estado}%'`);
  }

  // NIF
  if (filters.nif) {
    const nif = sqlEscape(filters.nif).toUpperCase();
    where.push(`nif_adjudicatario = '${nif}'`);
  }

  // Year filters
  const desde = validYear(filters.desde);
  const hasta = validYear(filters.hasta);
  if (desde) {
    where.push(`fecha_publicacion >= '${desde}-01-01'`);
  }
  if (hasta) {
    where.push(`fecha_publicacion <= '${hasta}-12-31'`);
  }

  // Fuente: PLACSP incluye el historico (PLACSP-hist); el resto filtra directo
  const fuenteFilter = filters.fuente && filters.fuente !== 'todas' ? filters.fuente : null;
  if (fuenteFilter) {
    const f = sqlEscape(fuenteFilter).toLowerCase();
    if (f === 'place' || f === 'placsp') {
      where.push(`(fuente = 'PLACE' OR fuente = 'PLACSP-hist')`);
    } else {
      where.push(`lower(fuente) = '${f}'`);
    }
  }

  const whereStr = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const dataSql = `SELECT id, fuente, expediente, organismo, objeto AS titulo, cpv, cpvs,
    importe, importe_licitacion, importe_adjudicacion, fecha_publicacion AS fecha, fecha_fin,
    url, estado, adjudicatario, nif_adjudicatario AS nif_adj
    FROM contratos_busqueda${whereStr}
    ORDER BY ${sortCol} ${sortDir} ${nullsOrder} LIMIT ${limit + 1} OFFSET ${offset}`;
  // Always skip COUNT — use hasMore indicator (LIMIT + 1 row trick)
  const countSql = `SELECT -1 AS total`;

  return { dataSql, countSql, limit };
}

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    // Auth check — all users must be signed in
    const auth = (locals as any).auth?.();
    const userId = auth?.userId;
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Debes iniciar sesión para buscar', code: 'auth_required' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Free-tier daily limit check
    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY } as any);
    const user = await client.users.getUser(userId);
    const meta = (user.publicMetadata as Record<string, any>) || {};
    const userPlan = getUserPlan(meta, user.username || undefined, userId);

    // Free-tier daily limit — consumo ATÓMICO al entrar (tarea 37): un solo
    // statement UPSERT con guard + RETURNING cierra la carrera check-then-act
    // (6 simultáneas pasaban todas). El cupo se gasta aunque la búsqueda falle
    // después (semántica documentada en api-usage.ts).
    let daily: { allowed: boolean; remaining: number; limit: number } | null = null;
    if (userPlan.plan === 'free') {
      daily = await consumeDailySearch(userId);
      if (!daily.allowed) {
        return new Response(JSON.stringify({
          error: 'Has alcanzado el límite de 3 búsquedas diarias del plan Free. Actualiza a Pro para búsquedas ilimitadas.',
          code: 'daily_limit_exceeded',
          remaining: 0,
          limit: daily.limit,
          upgrade_url: '/cuenta/plan',
        }), {
          status: 429, headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    const q = url.searchParams.get('q')?.trim() || '';
    const filters: Record<string, string> = {};
    for (const key of ['cpv', 'importeMin', 'importeMax', 'estado', 'fuente', 'nif', 'desde', 'hasta', 'limit', 'offset', 'sort', 'dir']) {
      const v = url.searchParams.get(key);
      if (v) filters[key] = v;
    }

    if (!q && !Object.keys(filters).length) {
      return new Response(JSON.stringify({ error: 'Introduce un término de búsqueda o filtro' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const { dataSql, countSql, limit: pageLimit } = buildBusquedaQuery(q, filters);

    // Run data + count in parallel
    const [rows, countResult] = await Promise.all([
      query(dataSql),
      query(countSql),
    ]);

    const rawTotal = countResult[0]?.total;
    const total = typeof rawTotal === 'bigint' ? Number(rawTotal) : (rawTotal || 0);
    const hasMore = rows.length > pageLimit;
    if (hasMore) rows.pop(); // remove the extra row

    // Convert BigInt to Number for JSON serialization
    const safeRows = rows.map((r: any) => {
      const out: any = {};
      for (const [k, v] of Object.entries(r)) {
        out[k] = typeof v === 'bigint' ? Number(v) : v;
      }
      return out;
    });

    // Attach AI summaries (best-effort; do NOT block on missing rows)
    if (safeRows.length > 0) {
      try {
        const ids = safeRows.map((r: any) => String(r.id).replace(/'/g, "''"));
        const idList = ids.map(() => '?').join(',');
        const aiRows = await query(
          `SELECT id_contrato, resumen FROM ia_resumenes WHERE id_contrato IN (${idList})`,
          ids
        );
        const aiMap = new Map((aiRows || []).map((row: any) => [row.id_contrato, row.resumen]));
        for (const r of safeRows) {
          (r as any).ai_resumen = aiMap.get(String(r.id)) || null;
        }
      } catch (aiErr) {
        console.error('[search] AI summary lookup failed:', aiErr);
      }
    }

    // Build response headers
    const responseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    };
    if (daily) {
      // remaining ya viene del RETURNING del consumo atómico — sin segunda query
      responseHeaders['X-Search-Remaining'] = String(daily.remaining);
      responseHeaders['X-Search-Limit'] = String(daily.limit);
    }

    return new Response(JSON.stringify({
      ok: true,
      hasMore,
      total: total === -1 ? null : total,
      count: safeRows.length,
      resultados: safeRows,
      query: q,
      filters,
    }), {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err: any) {
    console.error('[search] Error:', err.message);
    return new Response(JSON.stringify({ error: 'Error en la búsqueda', detail: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
