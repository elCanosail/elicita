import type { APIRoute } from 'astro';
import { query } from '../../lib/duckdb';
import { requireAuth } from '../../lib/api-auth';

export const GET: APIRoute = async ({ url, locals }) => {
  const { error } = requireAuth(locals);
  if (error) return error;
  const q = url.searchParams.get('q')?.trim() || '';

  if (!q || q.length < 2) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
    });
  }

  const like = `%${q}%`;

  try {
    const [companies, organisms] = await Promise.all([
      query(
        `SELECT DISTINCT adjudicatario as name, nif_adjudicatario as id, 'adjudicatario' as type
         FROM contratos_vivos
         WHERE adjudicatario ILIKE ? OR nif_adjudicatario ILIKE ?
         LIMIT 8`,
        [like, like]
      ),
      query(
        `SELECT DISTINCT organismo as name, organismo as id, 'organismo' as type
         FROM contratos_vivos
         WHERE organismo ILIKE ?
         LIMIT 8`,
        [like]
      ),
    ]);

    // Combine, deduplicate, cap at 10
    const combined = [...companies, ...organisms]
      .filter((r: any) => r.name && r.id)
      .slice(0, 10)
      .map((r: any) => ({
        name: String(r.name),
        id: String(r.id),
        type: String(r.type),
      }));

    return new Response(JSON.stringify(combined), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err: any) {
    console.error('[graph-search] Error:', err.message);
    return new Response(JSON.stringify({ error: 'Error en la búsqueda', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
