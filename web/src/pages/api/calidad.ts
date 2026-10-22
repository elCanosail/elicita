import type { APIRoute } from 'astro';
import { query } from '../../lib/duckdb';
import { requireAuth } from '../../lib/api-auth';

const INDICATORS = [
  'INT-VAL-01','INT-VAL-02','INT-VAL-03','INT-VAL-04','INT-VAL-05',
  'INT-VAL-06','INT-VAL-07','INT-VAL-09','INT-VAL-10','INT-VAL-12','INT-VAL-14',
  'INT-CONS-01','INT-CONS-08','INT-CONS-18','INT-CONS-20',
  'INT-FIA-01','INT-FIA-04','INT-FIA-08','INT-FIA-09','INT-FIA-11',
];

// Build the percentage SELECTs for all indicators
function buildIndicatorSelects(alias: string) {
  return INDICATORS.map(ind =>
    `ROUND(SUM(CASE WHEN ${alias}."${ind}" THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN ${alias}."${ind}" IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS "${ind}_pct"`
  ).join(',\n      ');
}

// Round a value to 2 decimals, or null
function round2(v: any): number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.round(v * 100) / 100;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const { error } = requireAuth(locals);
  if (error) return error;
  const url = new URL(request.url);
  const nif = url.searchParams.get('nif')?.trim() || '';
  const cpv = url.searchParams.get('cpv')?.trim() || '';
  const organo = url.searchParams.get('organo')?.trim() || '';
  const expediente = url.searchParams.get('expediente')?.trim() || '';

  // Require at least one query param
  if (!nif && !cpv && !organo && !expediente) {
    return new Response(JSON.stringify({ error: 'Se requiere al menos un parámetro: nif, cpv, organo o expediente' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Build WHERE clauses
    const where: string[] = [];
    const params: string[] = [];

    if (nif) { where.push('c.nif_adjudicatario = ?'); params.push(nif.toUpperCase()); }
    if (cpv) { where.push('c.cpv_principal LIKE ?'); params.push(cpv + '%'); }
    if (organo) { where.push('c.organo_contratante ILIKE ?'); params.push('%' + organo + '%'); }
    if (expediente) { where.push('c.expediente ILIKE ?'); params.push('%' + expediente + '%'); }

    const whereClause = where.join(' AND ');

    // ── 1. Aggregate stats ─────────────────────────────────────────
    const aggSelects = buildIndicatorSelects('c');
    const aggSql = `
      SELECT
        CAST(COUNT(*) AS INTEGER) AS total,
        ROUND(AVG(c.score_calidad), 2) AS score_avg,
        SUM(CASE WHEN c.es_menor THEN 1 ELSE 0 END) AS total_menor,
        ${aggSelects}
      FROM calidad c
      WHERE ${whereClause}
    `;

    const aggRows = await query(aggSql, params);
    const agg = aggRows[0];

    const aggregate = {
      total: agg?.total || 0,
      score_avg: round2(agg?.score_avg),
      total_menor: agg?.total_menor || 0,
      pass_rates: {} as Record<string, number | null>,
    };
    for (const ind of INDICATORS) {
      aggregate.pass_rates[ind] = round2(agg?.[`${ind}_pct`]);
    }

    // ── 2. Top contracts with scores ─────────────────────────────
    const detailSql = `
      SELECT
        c.id,
        c.expediente,
        c.objeto AS titulo,
        c.organo_contratante AS organo,
        c.nif_adjudicatario AS nif,
        c.adjudicatario,
        CAST(c.cpv_principal AS VARCHAR) AS cpv,
        ROUND(c.importe_adj_con_iva, 2) AS importe,
        c.fecha_adjudicacion AS fecha,
        c.estado,
        ROUND(c.score_calidad, 2) AS score,
        c.es_menor,
        c."INT-VAL-01", c."INT-VAL-02", c."INT-VAL-03", c."INT-VAL-04",
        c."INT-VAL-05", c."INT-VAL-06", c."INT-VAL-07", c."INT-VAL-09",
        c."INT-VAL-10", c."INT-VAL-12", c."INT-VAL-14",
        c."INT-CONS-01", c."INT-CONS-08", c."INT-CONS-18", c."INT-CONS-20",
        c."INT-FIA-01", c."INT-FIA-04", c."INT-FIA-08", c."INT-FIA-09", c."INT-FIA-11"
      FROM calidad c
      WHERE ${whereClause}
      ORDER BY c.score_calidad DESC NULLS LAST
      LIMIT 50
    `;

    const detailRows = await query(detailSql, params);

    const contracts = detailRows.map((r: any) => {
      const inds: Record<string, boolean | null> = {};
      for (const ind of INDICATORS) {
        inds[ind] = r[ind] ?? null;
      }
      return {
        id: r.id,
        expediente: r.expediente,
        titulo: r.titulo,
        organo: r.organo,
        nif: r.nif,
        adjudicatario: r.adjudicatario,
        cpv: r.cpv,
        importe: round2(r.importe),
        fecha: r.fecha,
        estado: r.estado,
        score: round2(r.score),
        es_menor: r.es_menor,
        indicators: inds,
      };
    });

    return new Response(JSON.stringify({
      query: { nif: nif || undefined, cpv: cpv || undefined, organo: organo || undefined, expediente: expediente || undefined },
      aggregate,
      contracts,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
    });

  } catch (err: any) {
    console.error('[calidad] query error:', err?.message);
    return new Response(JSON.stringify({ error: 'Error de base de datos', detail: err?.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
