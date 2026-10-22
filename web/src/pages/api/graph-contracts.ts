import type { APIRoute } from 'astro';
import { query } from '../../lib/duckdb';
import { requireAuth } from '../../lib/api-auth';

function toNum(v: any): number {
  if (typeof v === 'bigint') return Number(v);
  return Number(v) || 0;
}

function fmtDate(d: any): string {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (s.includes(' ')) {
    const dt = new Date(s);
    if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  return s.slice(0, 10);
}

export const GET: APIRoute = async ({ url, locals }) => {
  const { error } = requireAuth(locals);
  if (error) return error;
  const nif = url.searchParams.get('nif')?.trim() || '';
  const organismo = url.searchParams.get('organismo')?.trim() || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);

  if (!nif || !organismo) {
    return new Response(JSON.stringify({ error: 'Parámetros requeridos: nif, organismo' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const [contratos, stats] = await Promise.all([
      query(
        `SELECT id, fuente, expediente, objeto, cpv,
                importe_adjudicacion, fecha_publicacion, fecha_fin, url, estado
         FROM contratos_vivos
         WHERE nif_adjudicatario = ? AND organismo = ?
         ORDER BY fecha_publicacion DESC
         LIMIT ?`,
        [nif, organismo, limit]
      ),
      query(
        `SELECT COUNT(*) as total,
                COALESCE(SUM(importe_adjudicacion), 0) as volumen,
                MIN(fecha_publicacion) as primera,
                MAX(fecha_publicacion) as ultima
         FROM contratos_vivos
         WHERE nif_adjudicatario = ? AND organismo = ?`,
        [nif, organismo]
      ),
    ]);

    const s = stats[0] || {};
    const result = {
      contratos: contratos.map(r => ({
        id: r.id || '',
        fuente: r.fuente || '',
        expediente: r.expediente || '',
        objeto: r.objeto || '—',
        cpv: r.cpv || '',
        importe: toNum(r.importe_adjudicacion),
        fecha: fmtDate(r.fecha_publicacion),
        fecha_fin: fmtDate(r.fecha_fin),
        url: r.url || '',
        estado: r.estado || '',
      })),
      stats: {
        total: toNum(s.total),
        volumen: toNum(s.volumen),
        primera: fmtDate(s.primera),
        ultima: fmtDate(s.ultima),
      },
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (err: any) {
    console.error('[graph-contracts] Error:', err.message);
    return new Response(JSON.stringify({ error: 'Error al obtener contratos', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};