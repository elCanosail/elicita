/**
 * GET /api/v1/sector/<cpv>?año=2024
 *
 * Análisis competitivo del sector por código CPV (endpoint público, sin auth).
 *
 * Dado un CPV, devuelve:
 *  - resumen general (totales, proveedores/organismos únicos, rango de fechas)
 *  - top proveedores y top organismos por volumen adjudicado
 *  - distribución temporal (por año) y geográfica (por NUTS)
 *  - métricas de concentración (HHI, top 3/5/10 % volumen)
 *  - tendencia del volumen anual (creciente/estable/decreciente)
 *
 * Query params:
 *   - año (opcional): filtrar por EXTRACT(YEAR FROM fecha_publicacion)
 *
 * El código CPV se normaliza aceptando formatos como "33140000",
 * "3314.00.00" o "33140000.0" (se quitan puntos y ceros finales) y se usa
 * como PREFIJO (LIKE '3314%') para capturar toda la familia del CPV.
 *
 * Guardas (12-10-2026):
 *   - Rate limit 120/min por IP (lib/rate-limit, patrón de los endpoints públicos).
 *   - Memo TTL 300s por (cpv, año) — la respuesta es determinista dentro del
 *     ciclo de ingesta de 4h; evita repetir ≥5 agregaciones full-scan.
 *   - Fechas absurdas (fecha_publicacion < 1990, p. ej. epoch/1970) quedan
 *     fuera del análisis y se cuentan en contratos_excluidos_por_fecha.
 */
import type { APIRoute } from 'astro';
import { query } from '../../../../lib/duckdb';
import { rateLimitGuard } from '../../../../lib/rate-limit';
import { normalizeCpv } from '../../../../lib/cpv';

// ── Mapeo NUTS → CCAA (regiones mostradas en la salida) ──────────────────
const NUTS_TO_REGION: Record<string, string> = {
  'ES11': 'Galicia', 'ES12': 'Principado de Asturias', 'ES13': 'Cantabria',
  'ES21': 'País Vasco', 'ES22': 'Comunidad Foral de Navarra', 'ES23': 'La Rioja',
  'ES24': 'Aragón', 'ES30': 'Comunidad de Madrid', 'ES41': 'Castilla y León',
  'ES42': 'Castilla-La Mancha', 'ES43': 'Extremadura', 'ES51': 'Cataluña',
  'ES52': 'Comunidad Valenciana', 'ES53': 'Illes Balears', 'ES61': 'Andalucía',
  'ES62': 'Región de Murcia', 'ES63': 'Ciudad Autónoma de Ceuta',
  'ES64': 'Ciudad Autónoma de Melilla', 'ES70': 'Canarias',
};

/**
 * Normaliza un código CPV a su forma canónica (ver lib/cpv.ts — matching
 * por prefijo: "33140000" → "3314").
 */

/**
 * Columna de importe usada en todos los agregados: prefiere
 * importe_adjudicacion, con fallback a importe_sin_iva.
 */
const SEL_IMPORTE = `COALESCE(importe_adjudicacion, importe_sin_iva, 0)`;

/**
 * Suelo de fecha razonable para el análisis sectorial público: los contratos
 * con fecha_publicacion anterior a 1990 son errores de fuente (epoch/1970 y
 * similares) que envenenan primer_contrato y el bucket temporal. Se excluyen
 * de TODOS los agregados y se cuentan aparte (contratos_excluidos_por_fecha).
 */
const SANE_DATE_SQL = `fecha_publicacion >= DATE '1990-01-01'`;

// ── Memo TTL 300s (patrón stats.ts) ─────────────────────────────────
// Proceso vivo; el reinicio la limpia. Bounded para que un crawler con
// cpvs inventados no crezca el mapa sin límite.
const SECTOR_CACHE_TTL_MS = 5 * 60 * 1000;
const SECTOR_CACHE_MAX = 128;
const sectorCache = new Map<string, { data: unknown; timestamp: number }>();

/**
 * Herfindahl-Hirschman Index normalizado 0-1 a partir de los volúmenes
 * por proveedor. HHI = Σ (share_i)². 1 = monopolio absoluto, ~0 = atomizado.
 */
function computeHHi(volumes: number[]): number {
  if (!volumes || volumes.length === 0) return 0;
  const total = volumes.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  return volumes.reduce((acc, v) => acc + (v / total) ** 2, 0);
}

/**
 * Tendencia del sector a partir del volumen anual (EUR por año).
 * Compara la media de la primera mitad con la de la segunda:
 *   > +10% → creciente; < -10% → decreciente; en medio → estable.
 */
function computeTrend(yearly: Record<string, number>): string {
  const years = Object.keys(yearly).sort((a, b) => Number(a) - Number(b));
  if (years.length < 2) return 'estable';
  const values = years.map((y) => yearly[y]);
  const mid = Math.floor(values.length / 2);
  const first = values.slice(0, mid);
  const second = values.slice(mid);
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / Math.max(arr.length, 1);
  const base = avg(first);
  if (base <= 0) return 'estable';
  const diff = avg(second) - base;
  if (diff > base * 0.1) return 'creciente';
  if (diff < -base * 0.1) return 'decreciente';
  return 'estable';
}

/**
 * Formatea un número con separadores de miles (formato es-ES).
 */
function formatThousands(n: number): string {
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(n || 0);
}

/**
 * Convierte una row cruda de DuckDB en Record<string, any> manejando
 * BigInt (→ Number) y Date (→ YYYY-MM-DD).
 */
function toRow(r: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!r) return out;
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'bigint') out[k] = Number(v);
    else if (v instanceof Date) out[k] = v.toISOString().slice(0, 10);
    else out[k] = v;
  }
  return out;
}

function num(v: any, fallback = 0): number {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: any): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Respuesta JSON con headers CORS. */
function respond(status: number, body: unknown, allowCORS = true): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  };
  if (allowCORS) headers['Access-Control-Allow-Origin'] = '*';
  return new Response(JSON.stringify(body), { status, headers });
}

// ── Handle principal ──────────────────────────────────────────────────────
export const GET: APIRoute = async ({ params, request }) => {
  const start = Date.now();

  try {
    const cpv = normalizeCpv(typeof params?.cpv === 'string' ? params.cpv : null);

    if (!cpv) {
      return respond(400, {
        ok: false,
        error: 'Código CPV inválido. Formato esperado: 8 dígitos (ej. 33140000).',
      });
    }

    // Año opcional: aceptamos tanto `año` (con tilde) como `ano`.
    const url = new URL(request.url);
    const rawYear = url.searchParams.get('año') || url.searchParams.get('ano') || '';
    let year: number | null = null;
    if (rawYear) {
      const y = parseInt(rawYear, 10);
      if (!Number.isNaN(y) && y >= 2009 && y <= 2100) year = y;
    }

    // Rate limit (patrón de los endpoints públicos): 120/min por IP.
    const limited = rateLimitGuard(request, { name: 'v1-sector', limit: 120, windowMs: 60_000 });
    if (limited) return limited;

    // Memo TTL 300s por (cpv, año): la respuesta es determinista dentro del
    // ciclo de ingesta de 4h. Los 200 se sirven del cache byte-idénticos
    // (took_ms conserva el coste de cómputo original); 400/404 no se cachean.
    const cacheKey = `${cpv}:${year ?? ''}`;
    const hit = sectorCache.get(cacheKey);
    if (hit && Date.now() - hit.timestamp < SECTOR_CACHE_TTL_MS) {
      return respond(200, hit.data);
    }

    // Filtro CPV (sector): matching por prefijo sobre cpv_principal y
    // aparición dentro de cpvs (listas CSV/JSON). Usamos LIKE en lugar de
    // `=` porque `cpv_principal` guarda la forma completa ("33140000" o
    // "33140000.0" si se serializó desde DOUBLE), mientras que el código
    // normalizado (sin puntos ni ceros finales) es la faceta canónica con la
    // que el cliente llama al endpoint. El prefijo captura toda la familia
    // del CPV (clase + subcódigos), que es lo que pide un análisis sectorial.
    const like = `%${cpv}%`;
    const cpvClause = `(TRIM(REPLACE(REPLACE(CAST(cpv_principal AS VARCHAR), '.0', ''), ' ', '')) LIKE ? OR cpvs LIKE ?)`;
    const sqlParams: (string | number)[] = [cpv + '%', like];

    // Filtro año (si aplica).
    let yearClause = '';
    if (year !== null) {
      yearClause = ' AND EXTRACT(YEAR FROM fecha_publicacion) = ?';
      sqlParams.push(year);
    }

    // ── Resumen general (los excluidos por fecha se cuentan en el MISMO scan) ──
    const resumenSql = `
      SELECT COUNT(CASE WHEN ${SANE_DATE_SQL} THEN 1 END) AS total_contratos,
        COUNT(CASE WHEN NOT (${SANE_DATE_SQL}) THEN 1 END) AS contratos_excluidos_por_fecha,
        SUM(CASE WHEN ${SANE_DATE_SQL} THEN ${SEL_IMPORTE} END) AS volumen_total,
        COUNT(DISTINCT CASE WHEN ${SANE_DATE_SQL} AND nif_adjudicatario IS NOT NULL AND nif_adjudicatario != '' THEN nif_adjudicatario END) AS proveedores_unicos,
        COUNT(DISTINCT CASE WHEN ${SANE_DATE_SQL} AND organo_contratante IS NOT NULL AND organo_contratante != '' THEN organo_contratante END) AS organismos_unicos,
        MIN(CASE WHEN ${SANE_DATE_SQL} THEN fecha_publicacion END) AS primer_contrato,
        MAX(CASE WHEN ${SANE_DATE_SQL} THEN fecha_publicacion END) AS ultimo_contrato
      FROM calidad
      WHERE ${cpvClause}
        AND fecha_publicacion IS NOT NULL
        ${yearClause}
    `;
    const resumenRows = await query(resumenSql, sqlParams);
    const resumen = toRow(resumenRows[0]);

    const totalContratos = num(resumen.total_contratos);
    if (totalContratos === 0) {
      return respond(404, {
        ok: false,
        error: `No se encontraron contratos válidos para el CPV ${cpv}${year !== null ? ` en ${year}` : ''}.`,
        cpv,
      });
    }

    const volumenTotal = num(resumen.volumen_total);

    // ── Top proveedores (por volumen) ───────────────────────────────
    const proveedoresSql = `
      SELECT nif_adjudicatario, adjudicatario,
        COUNT(*) AS contratos,
        SUM(${SEL_IMPORTE}) AS volumen
      FROM calidad
      WHERE ${cpvClause}
        AND fecha_publicacion IS NOT NULL
        AND ${SANE_DATE_SQL}
        AND nif_adjudicatario IS NOT NULL AND nif_adjudicatario != ''
        ${yearClause}
      GROUP BY nif_adjudicatario, adjudicatario
      ORDER BY volumen DESC
      LIMIT 20
    `;
    const proveedoresRows = await query(proveedoresSql, sqlParams);
    const topProveedores = proveedoresRows.map((r: any) => {
      const row = toRow(r);
      const vol = num(row.volumen);
      return {
        nif: str(row.nif_adjudicatario),
        nombre: str(row.adjudicatario),
        contratos: num(row.contratos),
        volumen_eur: vol,
        pct_volumen: volumenTotal > 0 ? +(vol / volumenTotal).toFixed(4) : 0,
        pct_contratos: totalContratos > 0 ? +((num(row.contratos) / totalContratos)).toFixed(4) : 0,
      };
    });

    // ── Concentración: HHI sobre proveedores + top 3/5/10 % del volumen ──
    // Necesitamos los volúmenes de TODOS los proveedores, no solo el top 20.
    const proveedorVolumesSql = `
      SELECT nif_adjudicatario,
        SUM(${SEL_IMPORTE}) AS volumen
      FROM calidad
      WHERE ${cpvClause}
        AND fecha_publicacion IS NOT NULL
        AND ${SANE_DATE_SQL}
        AND nif_adjudicatario IS NOT NULL AND nif_adjudicatario != ''
        ${yearClause}
      GROUP BY nif_adjudicatario
      ORDER BY volumen DESC
    `;
    const proveedorVolumesAll = await query(proveedorVolumesSql, sqlParams);
    const allVolume = proveedorVolumesAll.map((r: any) => num(toRow(r).volumen));

    // Top de organismos (con nº de contratos y volumen).
    const organismosSql = `
      SELECT organo_contratante,
        COUNT(*) AS contratos,
        SUM(${SEL_IMPORTE}) AS volumen
      FROM calidad
      WHERE ${cpvClause}
        AND fecha_publicacion IS NOT NULL
        AND ${SANE_DATE_SQL}
        AND organo_contratante IS NOT NULL AND organo_contratante != ''
        ${yearClause}
      GROUP BY organo_contratante
      ORDER BY volumen DESC
      LIMIT 15
    `;
    const topOrganismos = (await query(organismosSql, sqlParams)).map((r: any) => {
      const row = toRow(r);
      return {
        organismo: str(row.organo_contratante),
        contratos: num(row.contratos),
        volumen_eur: num(row.volumen),
      };
    });

    // ── Distribución temporal ───────────────────────────────────────
    const temporalSql = `
      SELECT EXTRACT(YEAR FROM fecha_publicacion) AS anio,
        COUNT(*) AS contratos,
        SUM(${SEL_IMPORTE}) AS volumen
      FROM calidad
      WHERE ${cpvClause}
        AND fecha_publicacion IS NOT NULL
        AND ${SANE_DATE_SQL}
        ${yearClause}
      GROUP BY EXTRACT(YEAR FROM fecha_publicacion)
      ORDER BY EXTRACT(YEAR FROM fecha_publicacion) ASC
    `;
    const temporalRows = await query(temporalSql, sqlParams);
    const distribucionTemporal: Record<string, number> = {};
    const volumesByYear: Record<string, number> = {};
    for (const r of temporalRows) {
      const row = toRow(r);
      const y = String(row.anio);
      distribucionTemporal[y] = num(row.contratos);
      volumesByYear[y] = num(row.volumen);
    }

    // ── Distribución geográfica por NUTS ────────────────────────────
    const geoSql = `
      SELECT nuts,
        COUNT(*) AS contratos,
        SUM(${SEL_IMPORTE}) AS volumen
      FROM calidad
      WHERE ${cpvClause}
        AND fecha_publicacion IS NOT NULL
        AND ${SANE_DATE_SQL}
        AND nuts IS NOT NULL AND nuts != ''
        ${yearClause}
      GROUP BY nuts
      ORDER BY volumen DESC
      LIMIT 15
    `;
    const distribucionGeografica = (await query(geoSql, sqlParams)).map((r: any) => {
      const row = toRow(r);
      const code = str(row.nuts).slice(0, 4);
      return {
        nuts: code,
        region: NUTS_TO_REGION[code] || str(row.nuts),
        contratos: num(row.contratos),
        volumen_eur: num(row.volumen),
      };
    });

    // ── Concentración: HHI + top 3/5/10 % del volumen ───────────────
    const hhi = computeHHi(allVolume);
    const sortedVols = [...allVolume].sort((a, b) => b - a);
    const pctTop = (k: number) => {
      if (volumenTotal <= 0 || sortedVols.length === 0) return 0;
      const top = sortedVols.slice(0, k).reduce((a, b) => a + b, 0);
      return +(top / volumenTotal).toFixed(4);
    };
    const concentracion = {
      hhi: +hhi.toFixed(4),
      top_3_pct_volumen: pctTop(3),
      top_5_pct_volumen: pctTop(5),
      top_10_pct_volumen: pctTop(10),
    };

    // ── Tendencia (volumen anual) ───────────────────────────────────
    const tendencia = computeTrend(volumesByYear);

    const body = {
      ok: true,
      cpv,
      resumen: {
        total_contratos: totalContratos,
        contratos_excluidos_por_fecha: num(resumen.contratos_excluidos_por_fecha),
        volumen_total_eur: Math.round(volumenTotal),
        volumen_total_formateado: formatThousands(volumenTotal),
        contrato_medio_eur: totalContratos > 0 ? Math.round(volumenTotal / totalContratos) : 0,
        contrato_medio_formateado: formatThousands(totalContratos > 0 ? volumenTotal / totalContratos : 0),
        proveedores_unicos: num(resumen.proveedores_unicos),
        organismos_unicos: num(resumen.organismos_unicos),
        primer_contrato: str(resumen.primer_contrato) || null,
        ultimo_contrato: str(resumen.ultimo_contrato) || null,
      },
      top_proveedores: topProveedores,
      top_organismos: topOrganismos,
      distribucion_temporal: distribucionTemporal,
      distribucion_geografica: distribucionGeografica,
      concentracion,
      tendencia,
      meta: {
        took_ms: Date.now() - start,
        filtro_anno: year,
      },
    };
    if (sectorCache.size >= SECTOR_CACHE_MAX) sectorCache.clear();
    sectorCache.set(cacheKey, { data: body, timestamp: Date.now() });
    return respond(200, body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return respond(500, {
      ok: false,
      error: message,
    });
  }
};
