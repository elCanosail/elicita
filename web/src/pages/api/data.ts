import type { APIRoute } from 'astro';
import cpvData from '../../data/cpv_es.json';
import {
  queryContratos,
  getContratoById,
  getFuentes,
  normEstado,
} from '../../lib/duckdb';
import { requireAuth } from '../../lib/api-auth';

// Pre-built CPV prefix index for fast lookup (code_5digits → description)
const cpvPrefixDescriptions: Record<string, string> = {};
for (const [code, desc] of Object.entries(cpvData as Record<string, string>)) {
  const prefix = code.slice(0, 5);
  if (!cpvPrefixDescriptions[prefix]) cpvPrefixDescriptions[prefix] = desc.toLowerCase();
}

// ── Config ────────────────────────────────────────────────────────────────
const DEFAULT_LIMIT = 200;
const MAX_LIMIT     = 500;


// ── Normalizar contrato ───────────────────────────────────────────────────
function normalizeContrato(c: any) {
  const result: any = {
    id:                c.id || '',
    fuente:            c.fuente || 'Desconocido',
    expediente:        c.expediente || null,
    organismo:         c.organismo || 'Organismo no especificado',
    objeto:            c.objeto || 'Sin título',
    cpv:               c.cpv || '—',
    cpvs:              c.cpvs || [],
    importe:           c.importe,
    importe_num:       c.importe_num || 0,
    fecha_publicacion: c.fecha_publicacion || '',
    fecha_fin:         c.fecha_fin || null,
    url:               c.url,
    estado:            c.estado || 'abierta',
    adjudicatario:     c.adjudicatario || null,
    nif_adjudicatario: c.nif_adjudicatario || null,
  };
  if (c._relevance) result._relevance = c._relevance;
  return result;
}

// ── API Route ─────────────────────────────────────────────────────────────

export const GET: APIRoute = async ({ url: reqUrl, locals }) => {
  const __t0 = Date.now();
  const { error } = requireAuth(locals);
  if (error) return error;
  const p = reqUrl.searchParams;

  // ── Lookup por ID único ───────────────────────────────────────────────
  const lookupId = p.get('id');
  if (lookupId) {
    try {
      const contrato = await getContratoById(decodeURIComponent(lookupId));
      return new Response(JSON.stringify({
        contrato: contrato ? normalizeContrato(contrato) : null,
        ultima_actualizacion: new Date().toISOString(),
      }), {
        status: contrato ? 200 : 404,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    } catch (err) {
      console.error('[data] Error looking up contrato:', err);
      return new Response(JSON.stringify({
        contrato: null,
        ultima_actualizacion: new Date().toISOString(),
        error: 'Database error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  }

  // ── Params ───────────────────────────────────────────────────────────────
  const limit  = Math.min(parseInt(p.get('limit') || String(DEFAULT_LIMIT)), MAX_LIMIT);
  const page   = Math.max(1, parseInt(p.get('page') || '1'));
  const q = (p.get('q') || '').toLowerCase().trim();
  const sortBy = p.get('sort') || (q ? 'relevance' : 'fecha');
  const sortDir = (p.get('dir') || 'desc') === 'asc' ? 'asc' : 'desc';

  // Estados (comma-sep). Vacío = sin filtro de estado (devuelve todos)
  const estadosParam = p.get('estados') || '';
  const estados = estadosParam
    ? estadosParam.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  // Fuentes (comma-sep). Vacío = todas
  const fuentesParam = p.get('fuentes') || '';
  const fuentes = fuentesParam
    ? fuentesParam.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  // CPVs (comma-sep, prefix match 5 dígitos)
  const cpvsParam = p.get('cpvs') || '';
  const cpvs = cpvsParam
    ? cpvsParam.split(',').map(s => s.trim().replace('.0', '').slice(0, 5)).filter(s => s.length === 5)
    : undefined;

  // Importe
  const importeMin = parseFloat(p.get('importe_min') || '0') || 0;
  const importeMax = parseFloat(p.get('importe_max') || '0') || 0;

  // Organismos (comma-sep). Vacío = todos
  const orgsParam = p.get('organismos') || '';
  const organismos = orgsParam
    ? orgsParam.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  // Búsqueda texto (q already parsed above)
  const soloActivas = p.get('activas') === 'true';

  // ── Construir filtros ─────────────────────────────────────────────────
  const filters = {
    estados,
    fuentes,
    cpvs,
    importe_min: importeMin > 0 ? importeMin : undefined,
    importe_max: importeMax > 0 ? importeMax : undefined,
    organismos,
    q: q || undefined,
    sort: sortBy,
    dir: sortDir as 'asc' | 'desc',
    page,
    limit,
    solo_activas: soloActivas || undefined,
  };

  // ── Ejecutar consulta ────────────────────────────────────────────────
  try {
    const __t1 = Date.now();
    const { contratos: rawContratos, total } = await queryContratos(filters);
    const __t2 = Date.now();
    console.log(`[data] queryContratos: ${__t2 - __t1}ms (total: ${__t2 - __t0}ms) q=${filters.q || '-'} sort=${filters.sort} page=${page}`);
    const contratos = rawContratos.map(normalizeContrato);

    const pages = Math.ceil(total / limit);

    // Get fuentes disponibles
    let fuentesDisponibles: string[] = [];
    try {
      fuentesDisponibles = await getFuentes();
    } catch (e) {
      console.error('[data] Error fetching fuentes:', e);
    }

    return new Response(JSON.stringify({
      contratos,
      total,
      page,
      limit,
      pages,
      ultima_actualizacion: new Date().toISOString(),
      fuentes_disponibles: fuentesDisponibles,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error(`[data] Database error (${Date.now() - __t0}ms):`, err);
    return new Response(JSON.stringify({
      contratos: [],
      total: 0,
      page,
      limit,
      pages: 0,
      ultima_actualizacion: new Date().toISOString(),
      fuentes_disponibles: [],
      error: 'Database query failed',
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  }
};
