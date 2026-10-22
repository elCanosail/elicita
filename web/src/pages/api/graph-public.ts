import type { APIRoute } from 'astro';
import { query } from '../../lib/duckdb';
import { rateLimitGuard } from '../../lib/rate-limit';
import { cached } from '../../lib/cache';

// Memo de origen (lib/cache): CF no cachea JSON — 1 grafo por (type,q) y TTL.
// La clave conserva `q` verbatim: el matching por NIF es case-sensitive (SQL =).
const GRAPH_PUBLIC_CACHE_TTL_MS = 300_000;

/** Empresa no encontrada — el 404 no se cachea (pasa sin fijarse por TTL). */
class GraphNotFoundError extends Error {}

function toNum(v: any): number {
  if (typeof v === 'bigint') return Number(v);
  return Number(v) || 0;
}

export const GET: APIRoute = async ({ request, url }) => {
  const limited = rateLimitGuard(request, { name: 'public-graph', limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const q = url.searchParams.get('q')?.trim() || '';
  const type = url.searchParams.get('type')?.trim() || '';

  if (!q || !type || !['adjudicatario', 'organismo'].includes(type)) {
    return new Response(JSON.stringify({ error: 'Parámetros requeridos: q, type' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    if (type === 'adjudicatario') {
      const graph = await cached(
        `public:graph-public:v1:${type}:${q}`,
        GRAPH_PUBLIC_CACHE_TTL_MS,
        async () => {
      const companyRows = await query(
        `SELECT DISTINCT adjudicatario, nif_adjudicatario
         FROM contratos_vivos
         WHERE (nif_adjudicatario = ? OR adjudicatario ILIKE ?)
         LIMIT 1`,
        [q, q]
      );

      if (!companyRows.length) throw new GraphNotFoundError();

      const company = companyRows[0];
      const nif = company.nif_adjudicatario;
      const companyName = company.adjudicatario;

      const orgRows = await query(
        `SELECT organismo, COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
         FROM contratos_vivos
         WHERE nif_adjudicatario = ?
         GROUP BY organismo
         ORDER BY volumen DESC
         LIMIT 20`,
        [nif]
      );

      const nodesMap = new Map<string, any>();
      const edgesMap = new Map<string, any>();

      nodesMap.set(nif, {
        id: nif,
        name: companyName,
        type: 'adjudicatario',
        contratos: toNum(orgRows.reduce((s: number, r: any) => s + toNum(r.contratos), 0)),
        volumen: toNum(orgRows.reduce((s: number, r: any) => s + toNum(r.volumen), 0)),
      });

      for (const org of orgRows) {
        const orgId = `org:${org.organismo}`;
        nodesMap.set(orgId, {
          id: orgId,
          name: org.organismo,
          type: 'organismo',
          contratos: toNum(org.contratos),
          volumen: toNum(org.volumen),
        });
        const eKey = `${nif}|||${orgId}`;
        if (!edgesMap.has(eKey)) {
          edgesMap.set(eKey, {
            source: nif,
            target: orgId,
            contratos: toNum(org.contratos),
            volumen: toNum(org.volumen),
          });
        }
      }

      return {
        center: { id: nif, name: companyName, type: 'adjudicatario' },
        nodes: Array.from(nodesMap.values()).slice(0, 21),
        edges: Array.from(edgesMap.values()),
      };
      });
      return new Response(JSON.stringify(graph), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=86400, s-maxage=86400',
        },
      });
    }

    // type === 'organismo'
    const graphOrg = await cached(
      `public:graph-public:v1:${type}:${q}`,
      GRAPH_PUBLIC_CACHE_TTL_MS,
      async () => {
    const adjRows = await query(
      `SELECT nif_adjudicatario, adjudicatario, COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
       FROM contratos_vivos
       WHERE organismo = ?
       GROUP BY nif_adjudicatario, adjudicatario
       ORDER BY volumen DESC
       LIMIT 20`,
      [q]
    );

    const orgId = `org:${q}`;
    const nodesMap = new Map<string, any>();
    const edgesMap = new Map<string, any>();

    nodesMap.set(orgId, {
      id: orgId,
      name: q,
      type: 'organismo',
      contratos: toNum(adjRows.reduce((s: number, r: any) => s + toNum(r.contratos), 0)),
      volumen: toNum(adjRows.reduce((s: number, r: any) => s + toNum(r.volumen), 0)),
    });

    for (const adj of adjRows) {
      const adjId = adj.nif_adjudicatario || `adj:${adj.adjudicatario}`;
      nodesMap.set(adjId, {
        id: adjId,
        name: adj.adjudicatario,
        type: 'adjudicatario',
        contratos: toNum(adj.contratos),
        volumen: toNum(adj.volumen),
      });
      const eKey = `${orgId}|||${adjId}`;
      if (!edgesMap.has(eKey)) {
        edgesMap.set(eKey, {
          source: orgId,
          target: adjId,
          contratos: toNum(adj.contratos),
          volumen: toNum(adj.volumen),
        });
      }
    }

      return {
        center: { id: orgId, name: q, type: 'organismo' },
        nodes: Array.from(nodesMap.values()).slice(0, 21),
        edges: Array.from(edgesMap.values()),
      };
      });
      return new Response(JSON.stringify(graphOrg), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=86400, s-maxage=86400',
        },
      });
  } catch (err: any) {
    if (err instanceof GraphNotFoundError) {
      return new Response(JSON.stringify({ error: 'Empresa no encontrada' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.error('[graph-public] Error:', err.message);
    return new Response(JSON.stringify({ error: 'Error al construir el grafo', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
