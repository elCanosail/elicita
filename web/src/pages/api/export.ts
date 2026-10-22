/**
 * GET /api/export — Exporta resultados de búsqueda como CSV
 * Auth: Clerk session (Pro/Empresa only)
 * 
 * Query params: mismos que /api/search (q, fuente, cpv, date_from, date_to, etc.)
 * Límite: 200 filas por export (para evitar abuso)
 */
import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import { getUserPlan, canAccessFeature } from '../../lib/plan';
import { buildUnionQuery, query } from '../../lib/search';

async function authenticate(request: Request, locals: any): Promise<{ userId: string; plan: string } | null> {
  const auth = locals?.auth?.();
  if (!auth?.userId) return null;
  try {
    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const metadata = (user.publicMetadata || {}) as Record<string, any>;
    const plan = metadata?.plan || 'free';
    return { userId: auth.userId, plan };
  } catch {
    return null;
  }
}

function csvEscape(value: any): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'bigint' ? Number(value).toString() : String(value);
  // Escape quotes and wrap in quotes if contains comma, quote, or newline
  if (/[",\n\r;]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

const CSV_COLUMNS = [
  { key: 'fuente', label: 'Fuente' },
  { key: 'expediente', label: 'Expediente' },
  { key: 'organismo', label: 'Organismo' },
  { key: 'objeto', label: 'Objeto' },
  { key: 'cpv', label: 'CPV' },
  { key: 'importe_licitacion', label: 'Importe Licitación' },
  { key: 'importe_adjudicacion', label: 'Importe Adjudicación' },
  { key: 'fecha_publicacion', label: 'Fecha Publicación' },
  { key: 'fecha_fin', label: 'Fecha Fin' },
  { key: 'estado', label: 'Estado' },
  { key: 'adjudicatario', label: 'Adjudicatario' },
  { key: 'nif_adjudicatario', label: 'NIF Adjudicatario' },
  { key: 'url', label: 'URL' },
];

export const GET: APIRoute = async ({ url: reqUrl, request, locals }) => {
  try {
    const auth = await authenticate(request, locals);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const userPlan = getUserPlan(
      (user.publicMetadata as Record<string, any>) || {},
      user.username || undefined,
      auth.userId,
    );

    // Export requires Pro or higher
    if (!canAccessFeature(userPlan.plan, 'alerts')) {
      return new Response(JSON.stringify({
        error: 'Export CSV requiere plan Pro',
        upgrade: '/precios',
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Parse search params
    const params = reqUrl.searchParams;
    const q = (params.get('q') || '').trim();
    const filters: Record<string, string> = {};
    for (const [key, value] of params.entries()) {
      if (key !== 'q') filters[key] = value;
    }

    // Force limit to 200 for export
    filters.limit = '200';
    filters.offset = '0';

    const { dataSql } = buildUnionQuery(q, filters);
    const rows = await query(dataSql);

    // Build CSV
    const header = CSV_COLUMNS.map(c => csvEscape(c.label)).join(',');
    const lines = rows.map((row: any) => {
      return CSV_COLUMNS.map(col => {
        const val = row[col.key];
        if (col.key === 'fecha_publicacion' || col.key === 'fecha_fin') {
          return val ? csvEscape(String(val).slice(0, 10)) : '';
        }
        if (col.key === 'importe_licitacion' || col.key === 'importe_adjudicacion') {
          const n = typeof val === 'bigint' ? Number(val) : val;
          return n ? csvEscape(Number(n).toFixed(2)) : '';
        }
        return csvEscape(val);
      }).join(',');
    });

    const csv = [header, ...lines].join('\n');
    const filename = `elicita_${q ? q.replace(/[^a-z0-9]/gi, '_').slice(0, 30) : 'export'}_${new Date().toISOString().slice(0, 10)}.csv`;

    return new Response('\ufeff' + csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('[export] Error:', err.message);
    return new Response(JSON.stringify({ error: 'Error al exportar', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};