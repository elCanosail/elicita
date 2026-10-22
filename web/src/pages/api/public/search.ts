/**
 * Public search endpoint
 * GET /api/public/search?q=...&cpv=...&date_from=...&date_to=...
 * No auth required. IP-based token-bucket rate limit: 3 searches/day.
 */
import type { APIRoute } from 'astro';
import { buildUnionQuery, query } from '../../../lib/search';
import { queryState } from '../../../lib/duckdb';
import { applyRerank, detectNoClearMatch, jevRerank, jevRerankEnabled } from '../../../lib/jev-rerank';
import { checkRateLimit } from '../../../lib/rate-limit';

const DAILY_LIMIT = 3;

function normalizeFilters(url: URL): Record<string, string> {
  const filters: Record<string, string> = {};
  const keys = ['cpv', 'importeMin', 'importeMax', 'estado', 'fuente', 'nif', 'desde', 'hasta', 'limit', 'offset', 'sort', 'dir'];
  for (const key of keys) {
    const v = url.searchParams.get(key);
    if (v) filters[key] = v;
  }
  return filters;
}

export const GET: APIRoute = async ({ request }) => {
  const startTime = Date.now();
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim() || '';
  const filters = normalizeFilters(url);

  // Enforce anonymous result limit
  const anonLimit = Math.min(parseInt(filters.limit || '10'), 20);
  filters.limit = String(anonLimit);
  const offset = parseInt(filters.offset || '0') || 0;

  if (!q && !Object.keys(filters).some((k) => k !== 'limit' && k !== 'offset')) {
    return new Response(JSON.stringify({ error: 'Introduce un término de búsqueda o filtro' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rate = checkRateLimit(request, { name: 'public-search', limit: DAILY_LIMIT, windowMs: 86_400_000 });

  if (!rate.allowed) {
    return new Response(
      JSON.stringify({
        error: 'Has alcanzado el límite de búsquedas diarias como usuario anónimo.',
        code: 'daily_limit_exceeded',
        remaining: 0,
        limit: DAILY_LIMIT,
        anonymous: true,
        cta: 'Regístrate para más búsquedas',
        upgrade_url: '/sign-up',
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': String(DAILY_LIMIT),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(rate.resetTime)),
          'Retry-After': String(Math.max(1, Math.ceil(rate.resetTime - Date.now() / 1000))),
        },
      }
    );
  }

  try {
    const { dataSql, countSql, limit: pageLimit } = buildUnionQuery(q, filters);

    const [rawRows, countResult] = await Promise.all([query(dataSql), query(countSql)]);

    const rawTotal = countResult[0]?.total;
    const total = typeof rawTotal === 'bigint' ? Number(rawTotal) : (rawTotal || 0);
    const hasMore = rawRows.length > pageLimit;
    if (hasMore) rawRows.pop();

    const results = rawRows.map((r: any) => {
      const out: any = {};
      for (const [k, v] of Object.entries(r)) {
        out[k] = typeof v === 'bigint' ? Number(v) : v;
      }
      return out;
    });

    // Smart search (opt-in): JEV semantic re-ranking over the retrieved page.
    // Double gate: ?smart=1 from the caller AND ELICITA_JEV_SMART=1 server-side
    // with an API key. Fails open: any error keeps the classic tokenized order.
    const wantSmart = url.searchParams.get('smart') === '1';
    let smartUsed = false;
    let jevMs: number | undefined;
    let noClearMatch: boolean | undefined;
    if (wantSmart && q && results.length >= 2 && jevRerankEnabled()) {
      const rr = await jevRerank(q, results);
      if (rr) {
        const ordered = applyRerank(results, rr.scores);
        results.length = 0;
        results.push(...ordered);
        for (const r of results) r.jev_score = rr.scores[r.id] ?? 0;
        for (const r of results) delete r._score;
        smartUsed = true;
        jevMs = rr.ms;
        // Honest labeling only — never gates (spike point 3).
        noClearMatch = detectNoClearMatch(rr.scores);
      }
    }

    // Attach AI summaries (best-effort; do NOT block on missing rows)
    if (results.length > 0) {
      try {
        const ids = results.map((r: any) => String(r.id).replace(/'/g, "''"));
        const idList = ids.map(() => '?').join(',');
        const aiRows = await queryState(
          `SELECT id_contrato, resumen FROM ia_resumenes WHERE id_contrato IN (${idList})`,
          ids
        );
        const aiMap = new Map((aiRows || []).map((row: any) => [row.id_contrato, row.resumen]));
        for (const r of results) {
          r.ai_resumen = aiMap.get(String(r.id)) || null;
        }
      } catch (aiErr) {
        console.error('[public/search] AI summary lookup failed:', aiErr);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        anonymous: true,
        cta: 'Regístrate para más búsquedas',
        smart: smartUsed,
        no_clear_match: noClearMatch,
        query: {
          q,
          filters: {
            cpv: filters.cpv || undefined,
            importeMin: filters.importeMin || undefined,
            importeMax: filters.importeMax || undefined,
            estado: filters.estado || undefined,
            fuente: filters.fuente || undefined,
            nif: filters.nif || undefined,
            desde: filters.desde || undefined,
            hasta: filters.hasta || undefined,
          },
        },
        results,
        pagination: {
          limit: anonLimit,
          offset,
          has_more: hasMore,
        },
        meta: {
          took_ms: Date.now() - startTime,
          jev_ms: jevMs,
          rate_limit_remaining: rate.remaining,
          total: total === -1 ? undefined : total,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-RateLimit-Limit': String(DAILY_LIMIT),
          'X-RateLimit-Remaining': String(rate.remaining),
          'X-RateLimit-Reset': String(Math.ceil(rate.resetTime)),
        },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return new Response(JSON.stringify({ error: message, anonymous: true }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
