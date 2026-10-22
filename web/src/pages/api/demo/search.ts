/**
 * GET /api/demo/search?q=preset
 * Public endpoint (no auth) that returns real data for preset queries.
 * Used by /demo page. Limited to 5 results per preset.
 * No rate limit — queries are predefined, not user-generated.
 */
import type { APIRoute } from 'astro';
import { query } from '../../../lib/duckdb';

const PRESETS: Record<string, { term: string; cpv?: string; label: string; desc: string }> = {
  software: {
    term: 'software',
    cpv: '72000000',
    label: 'Software y TI',
    desc: 'Desarrollo, licencias, soporte, infraestructura tecnológica',
  },
  construccion: {
    term: 'obras',
    cpv: '45200000',
    label: 'Construcción y obras',
    desc: 'Edificación, infraestructura, saneamiento, reformas',
  },
  sanidad: {
    term: 'material médico',
    cpv: '33000000',
    label: 'Sanidad',
    desc: 'Material médico, equipamiento hospitalario, farmacia',
  },
  consultoria: {
    term: 'consultoría',
    cpv: '79000000',
    label: 'Consultoría',
    desc: 'Asesoría, estudios técnicos, auditorías, formación',
  },
  climatizacion: {
    term: 'climatización',
    cpv: '39700000',
    label: 'Climatización',
    desc: ' HVAC, refrigeración, ventilación, mantenimiento térmico',
  },
};

const LIMIT = 5;

export const GET: APIRoute = async ({ url }) => {
  const preset = url.searchParams.get('q') || 'software';
  const config = PRESETS[preset];
  if (!config) {
    return new Response(JSON.stringify({ error: 'Preset no válido' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Build a real query against contratos_vivos
    // Use ILIKE for text search + optional CPV prefix match
    const term = config.term.replace(/'/g, "''");
    const cpv = config.cpv || '';
    const cpvClause = cpv ? `AND cpv LIKE '${cpv.slice(0, 2)}%'` : '';

    const sql = `
      SELECT
        id, fuente, expediente, organismo, objeto, cpv,
        importe_licitacion, importe_adjudicacion,
        fecha_publicacion, estado, adjudicatario, nif_adjudicatario, url
      FROM contratos_vivos
      WHERE (objeto ILIKE '%${term}%' OR organismo ILIKE '%${term}%')
      ${cpvClause}
      ORDER BY fecha_publicacion DESC NULLS LAST
      LIMIT ${LIMIT + 1}
    `;

    const rows = await query(sql);
    const hasMore = rows.length > LIMIT;
    if (hasMore) rows.pop();

    const safeRows = rows.map((r: any) => {
      const out: any = {};
      for (const [k, v] of Object.entries(r)) {
        out[k] = typeof v === 'bigint' ? Number(v) : v;
      }
      return out;
    });

    return new Response(JSON.stringify({
      ok: true,
      preset,
      label: config.label,
      desc: config.desc,
      count: safeRows.length,
      hasMore,
      resultados: safeRows,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300', // 5 min cache
      },
    });
  } catch (err: any) {
    console.error('[demo/search] Error:', err.message);
    return new Response(JSON.stringify({
      error: 'Error al buscar datos de demostración',
      detail: err.message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};