import { query } from './duckdb';

export interface CcaaConfig {
  slug: string;
  nombre: string;
  fuente: string | string[] | null;
  organismoLike: string[];
}

export interface CcaaDatos {
  total: number;
  importe_total: number;
  activas: number;
  fuentes_activas: number;
  top_organismos: any[];
  top_sectores: any[];
  ultimas_licitaciones: any[];
  adjudicaciones_recientes: any[];
}

export const CCAA_LIST: CcaaConfig[] = [
  { slug: 'andalucia', nombre: 'Andalucía', fuente: 'ANDALUCIA', organismoLike: [] },
  { slug: 'cataluna', nombre: 'Cataluña', fuente: 'CATALUNYA', organismoLike: [] },
  { slug: 'galicia', nombre: 'Galicia', fuente: 'GALICIA', organismoLike: [] },
  { slug: 'euskadi', nombre: 'Euskadi', fuente: 'EUSKADI', organismoLike: [] },
  { slug: 'asturias', nombre: 'Asturias', fuente: 'ASTURIAS', organismoLike: [] },
  { slug: 'valencia', nombre: 'Comunidad Valenciana', fuente: 'VALENCIA', organismoLike: [] },
  { slug: 'madrid', nombre: 'Comunidad de Madrid', fuente: ['MADRID'], organismoLike: [] },
  { slug: 'aragon', nombre: 'Aragón', fuente: null, organismoLike: ['%Aragón%', '%Zaragoza%', '%Huesca%', '%Teruel%'] },
  { slug: 'canarias', nombre: 'Canarias', fuente: null, organismoLike: ['%Canarias%', '%Tenerife%', '%Palmas%', '%Las Palmas%', '%Santa Cruz de Tenerife%'] },
  { slug: 'cantabria', nombre: 'Cantabria', fuente: null, organismoLike: ['%Cantabria%', '%Santander%'] },
  { slug: 'castilla-la-mancha', nombre: 'Castilla-La Mancha', fuente: null, organismoLike: ['%Castilla-La Mancha%', '%Castilla La Mancha%', '%Toledo%', '%Albacete%', '%Ciudad Real%', '%Cuenca%', '%Guadalajara%'] },
  { slug: 'castilla-y-leon', nombre: 'Castilla y León', fuente: null, organismoLike: ['%Castilla y León%', '%Castilla y Leon%', '%Valladolid%', '%Burgos%', '%León%', '%Salamanca%', '%Segovia%', '%Ávila%', '%Zamora%', '%Palencia%', '%Soria%'] },
  { slug: 'extremadura', nombre: 'Extremadura', fuente: null, organismoLike: ['%Extremadura%', '%Badajoz%', '%Cáceres%', '%Caceres%'] },
  { slug: 'la-rioja', nombre: 'La Rioja', fuente: null, organismoLike: ['%La Rioja%', '%Logroño%', '%Logrono%'] },
  { slug: 'murcia', nombre: 'Región de Murcia', fuente: null, organismoLike: ['%Murcia%', '%Cartagena%'] },
  { slug: 'navarra', nombre: 'Navarra', fuente: null, organismoLike: ['%Navarra%', '%Pamplona%'] },
  { slug: 'baleares', nombre: 'Islas Baleares', fuente: null, organismoLike: ['%Baleares%', '%Balears%', '%Mallorca%', '%Menorca%', '%Ibiza%', '%Formentera%', '%Palma%'] },
];

function parseCpv(cpv: string | null): string {
  if (!cpv || !cpv.trim()) return 'Sin clasificar';
  // Euskadi stores CPV as JSON array: [{"name":"..."}]
  if (cpv.startsWith('[')) {
    try {
      const items = JSON.parse(cpv);
      const names = items.map((item: any) => {
        let name = item.name || '';
        // Split CamelCase: "ServiciosTI:consultoría" → "Servicios TI: consultoría"
        name = name.replace(/([a-zà-ÿ])([A-ZÀ-Ý])/g, '$1 $2');
        name = name.replace(/([A-ZÀ-Ý]+)([A-ZÀ-Ý][a-zà-ÿ])/g, '$1 $2');
        return name;
      }).filter(Boolean);
      return names.join(' | ') || 'Sin clasificar';
    } catch {
      return cpv;
    }
  }
  // Standard CPV: "48000000-1" or just text
  return cpv;
}

function buildCcaaFilter(ccaa: CcaaConfig): { sql: string; params: any[] } {
  const params: any[] = [];
  const conditions: string[] = [];

  if (ccaa.fuente) {
    const fuentes = Array.isArray(ccaa.fuente) ? ccaa.fuente : [ccaa.fuente];
    conditions.push(`fuente IN (${fuentes.map(() => '?').join(',')})`);
    params.push(...fuentes);
  }

  if (ccaa.organismoLike.length > 0) {
    const organismoConditions = ccaa.organismoLike.map(() => 'organismo ILIKE ?');
    conditions.push(`(${organismoConditions.join(' OR ')})`);
    params.push(...ccaa.organismoLike);
  }

  return {
    sql: conditions.length > 0 ? `(${conditions.join(' OR ')})` : '(1=1)',
    params,
  };
}

export async function getDatos(ccaa: CcaaConfig): Promise<CcaaDatos> {
  const filter = buildCcaaFilter(ccaa);

  // CCAA pages need several heavy queries. Run them sequentially so DuckDB
  // can free intermediate state between steps and avoid blowing the 1 GB limit.

  const totalSql = `SELECT COUNT(*) as total FROM contratos_vivos WHERE ${filter.sql}`;
  const totalRows = await query(totalSql, [...filter.params]);
  const total = Number(totalRows[0]?.total || 0);

  const importeSql = `SELECT COALESCE(SUM(CASE WHEN COALESCE(NULLIF(importe_licitacion, 0), importe_adjudicacion, 0) BETWEEN 0 AND 100000000000 THEN COALESCE(NULLIF(importe_licitacion, 0), importe_adjudicacion, 0) ELSE 0 END), 0) as importe_total FROM contratos_vivos WHERE ${filter.sql}`;
  const importeRows = await query(importeSql, [...filter.params]);
  const importe_total = Number(importeRows[0]?.importe_total || 0);

  const activasSql = `SELECT COUNT(*) as activas FROM contratos_vivos WHERE ${filter.sql} AND (fecha_fin IS NULL OR fecha_fin >= CURRENT_DATE) AND COALESCE(NULLIF(importe_licitacion, 0), importe_adjudicacion, 0) BETWEEN 0 AND 100000000000`;
  const activasRows = await query(activasSql, [...filter.params]);
  const activas = Number(activasRows[0]?.activas || 0);

  const fuentesSql = `SELECT COUNT(DISTINCT fuente) as fuentes_activas FROM contratos_vivos WHERE ${filter.sql}`;
  const fuentesRows = await query(fuentesSql, [...filter.params]);
  const fuentes_activas = Number(fuentesRows[0]?.fuentes_activas || 0);

  const topOrganismosSql = `
    SELECT organismo, COUNT(*) as total, SUM(COALESCE(NULLIF(importe_licitacion, 0), importe_adjudicacion, 0)) as importe_total
    FROM contratos_vivos
    WHERE ${filter.sql} AND organismo IS NOT NULL
    GROUP BY organismo
    ORDER BY total DESC
    LIMIT 5
  `;
  const top_organismos = await query(topOrganismosSql, [...filter.params]);

  const topSectoresSql = `
    SELECT
      CASE
        WHEN cpv IS NULL OR TRIM(cpv) = '' THEN 'Sin clasificar'
        ELSE cpv
      END as cpv,
      COUNT(*) as total
    FROM contratos_vivos
    WHERE ${filter.sql}
    GROUP BY cpv
    ORDER BY total DESC
    LIMIT 5
  `;
  const top_sectores = await query(topSectoresSql, [...filter.params]);

  const ultimasLicitacionesSql = `
    SELECT id, fuente, expediente, organismo, objeto, COALESCE(NULLIF(importe_licitacion, 0), importe_adjudicacion, 0) as importe_licitacion, estado, fecha_fin
    FROM contratos_vivos
    WHERE ${filter.sql} AND (fecha_fin IS NULL OR fecha_fin >= CURRENT_DATE)
    ORDER BY fecha_publicacion DESC NULLS LAST
    LIMIT 10
  `;
  const ultimas_licitaciones = await query(ultimasLicitacionesSql, [...filter.params]);

  const adjudicacionesSql = `
    SELECT id, fuente, expediente, organismo, objeto, importe_adjudicacion, adjudicatario, fecha_publicacion
    FROM contratos_vivos
    WHERE ${filter.sql}
      AND adjudicatario IS NOT NULL
      AND fecha_publicacion >= CURRENT_DATE - INTERVAL 30 DAY
    ORDER BY fecha_publicacion DESC NULLS LAST
    LIMIT 10
  `;
  const adjudicaciones_recientes = await query(adjudicacionesSql, [...filter.params]);

  return {
    total,
    importe_total,
    activas,
    fuentes_activas,
    top_organismos: top_organismos.map((r: any) => ({
      organismo: r.organismo,
      total: Number(r.total),
      importe_total: Number(r.importe_total || 0),
    })),
    top_sectores: top_sectores.map((r: any) => ({
      cpv: parseCpv(r.cpv),
      total: Number(r.total),
    })),
    ultimas_licitaciones: ultimas_licitaciones.map((r: any) => ({
      id: r.id,
      fuente: r.fuente,
      expediente: r.expediente,
      organismo: r.organismo,
      objeto: r.objeto,
      importe_licitacion: r.importe_licitacion || 0,
      estado: r.estado,
      fecha_fin: r.fecha_fin,
    })),
    adjudicaciones_recientes: adjudicaciones_recientes.map((r: any) => ({
      id: r.id,
      fuente: r.fuente,
      expediente: r.expediente,
      organismo: r.organismo,
      objeto: r.objeto,
      importe_adjudicacion: r.importe_adjudicacion,
      adjudicatario: r.adjudicatario,
      fecha_publicacion: r.fecha_publicacion,
    })),
  };
}
