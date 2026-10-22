import type { APIRoute } from 'astro';
import { query } from '../../lib/duckdb';
import { rateLimitGuard } from '../../lib/rate-limit';
import { cached } from '../../lib/cache';

// Memo de origen (lib/cache): CF no cachea JSON — 1 búsqueda por q y TTL.
const GRAPH_SEARCH_CACHE_TTL_MS = 300_000;

export const GET: APIRoute = async ({ request, url }) => {
  const limited = rateLimitGuard(request, { name: 'public-graph-search', limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const q = url.searchParams.get('q')?.trim() || '';

  if (!q || q.length < 2) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600, s-maxage=3600' },
    });
  }

  const like = `%${q}%`;

  try {
    const results = await cached(
      `public:graph-search:v1:${q}`,
      GRAPH_SEARCH_CACHE_TTL_MS,
      async () => {
    const [companies, organisms] = await Promise.all([
      query(
        `SELECT DISTINCT adjudicatario as name, nif_adjudicatario as id, 'adjudicatario' as type
         FROM contratos_vivos
         WHERE (adjudicatario ILIKE ? OR nif_adjudicatario ILIKE ?)
         LIMIT 5`,
        [like, like]
      ),
      query(
        `SELECT DISTINCT organismo as name, organismo as id, 'organismo' as type
         FROM contratos_vivos
         WHERE organismo ILIKE ?
         LIMIT 5`,
        [like]
      ),
    ]);

    const seen = new Set<string>();
    const combined: any[] = [];

    const pushUnique = (r: any) => {
      if (!r.name || !r.id) return;
      const key = `${String(r.type)}:${String(r.id)}`;
      if (seen.has(key)) return;
      seen.add(key);
      combined.push({
        name: String(r.name),
        id: String(r.id),
        type: String(r.type),
      });
    };

    for (const r of companies) pushUnique(r);
    for (const r of organisms) pushUnique(r);

    return combined.slice(0, 8);
    });

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  } catch (err: any) {
    console.error('[graph-search-public] Error:', err.message);
    return new Response(JSON.stringify({ error: 'Error en la búsqueda', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
