/**
 * Shared search utilities for the Elicita buscador.
 *
 * Desde 2026-09-26 las búsquedas van sobre `contratos_busqueda`: la tabla
 * materializada que une la ventana viva (contratos_json_saneados) con el
 * histórico PLACSP desde 2012 (calidad), deduplicada por expediente|organismo.
 * El materializador debe reconstruirla tras cada ciclo de ingesta (y su índice
 * FTS cuando el paquete duckdb soporte create_fts_index sin crash — verificado
 * 2026-09-26: el paquete actual hace stack smashing en PRAGMA create_fts_index).
 *
 * El esquema proyectado sigue siendo el mismo que consumían las fuentes _json:
 *   id, fuente, expediente, organismo, objeto/titulo, cpv, cpvs,
 *   importe_licitacion, importe_adjudicacion, fecha_publicacion/fecha,
 *   fecha_fin, url, estado, adjudicatario, nif_adjudicatario
 */
import { query } from './duckdb';

export interface SourceDef {
  table: string;
  fuente: string;
}

/**
 * Fuentes históricas de las que se materializó contratos_busqueda (2026-09-26):
 * PLACSP nacional (calidad), TED, Madrid CM, Andalucía, Asturias, Euskadi,
 * Cataluña (13 datasets de contratación) y el ROC de la GVA 2014-2025.
 * Se conservan por compatibilidad con consumidores que las listan.
 */
export const SOURCES: SourceDef[] = [
  { table: 'placsp_json', fuente: 'PLACE' },
  { table: 'ted_json', fuente: 'TED' },
  { table: 'galicia_json', fuente: 'Galicia' },
  { table: 'andalucia_json', fuente: 'Andalucía' },
  { table: 'euskadi_json', fuente: 'Euskadi' },
  { table: 'madrid_cm_json', fuente: 'Madrid' },
  { table: 'catalunya_json', fuente: 'Catalunya' },
  { table: 'asturias_json', fuente: 'Asturias' },
  { table: 'valencia_json', fuente: 'Valencia' },
  { table: 'doga_json', fuente: 'Aragón' },
];

export interface UnionQueryResult {
  dataSql: string;
  countSql: string;
  limit: number;
}

/**
 * Escape a string for safe interpolation into DuckDB SQL.
 */
function sqlEscape(s: string): string {
  return String(s || '').replace(/[\\']/g, (m) => (m === "'" ? "''" : '\\\\')).replace(/[\x00-\x1f]/g, '');
}

/**
 * Tokenize a free-text query into search terms for lax matching.
 * - Words shorter than 3 chars are dropped (Spanish stopword noise).
 * - Deduped and capped at 8 terms to bound SQL size.
 * - A fully quoted term ("...") keeps legacy exact-phrase behavior as one term.
 * - If no word survives the length filter, falls back to the whole phrase.
 */
export function buildSearchTerms(term: string): string[] {
  const raw = String(term || '').trim();
  if (!raw) return [];
  const quoted = raw.match(/^"(.*)"$/s);
  if (quoted) {
    const t = sqlEscape(quoted[1].toLowerCase()).trim();
    return t ? [t] : [];
  }
  const words = [
    ...new Set(
      raw
        .toLowerCase()
        .split(/\s+/)
        .map((w) => sqlEscape(w))
        .filter((w) => w.length >= 3)
    ),
  ].slice(0, 8);
  if (words.length === 0) {
    const t = sqlEscape(raw.toLowerCase());
    return t ? [t] : [];
  }
  return words;
}

/**
 * Validate a year string (4 digits, 2000-2099).
 */
function validYear(s: string): string | null {
  const y = String(s || '').trim();
  return /^\d{4}$/.test(y) && +y >= 2000 && +y <= 2099 ? y : null;
}

/**
 * Validate a numeric string (non-negative number).
 */
function validNumber(s: string): number | null {
  const n = parseFloat(String(s || ''));
  return isNaN(n) || n < 0 ? null : n;
}

/**
 * Build the search query over contratos_busqueda with push-down filters.
 * All user-supplied values are escaped/validated before interpolation.
 */
export function buildUnionQuery(term: string, filters: Record<string, string>): UnionQueryResult {
  const limit = Math.min(parseInt(filters.limit || '50'), 200);
  const offset = Math.max(0, parseInt(filters.offset || '0') || 0);
  const terms = buildSearchTerms(term);

  // Sort config — whitelist maps client aliases to the *projected* column
  // names (the `AS <alias>` used in each subquery). The outer ORDER BY
  // operates on the search result so only projected aliases are available.
  //
  // SECURITY: the allowlist uses a null-prototype object so that inherited
  // keys (__proto__, constructor, toString, hasOwnProperty, ...) never resolve
  // as sortable columns. A plain object literal would make `sort=__proto__`
  // return Object.prototype (truthy) and interpolate it into SQL. With a
  // null-prototype object those lookups return undefined and fall through to
  // the default 'fecha'.
  const validSortCols: Record<string, string> = Object.assign(Object.create(null), {
    titulo: 'titulo',
    organismo: 'organismo',
    adjudicatario: 'adjudicatario',
    importe: 'importe',
    fuente: 'fuente',
    fecha: 'fecha',
  });
  const sortCol = validSortCols[filters.sort || ''] || 'fecha';
  const sortDir = filters.dir === 'asc' ? 'ASC' : 'DESC';
  const nullsOrder = sortDir === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';

  // Fuente filter
  const fuenteFilter = filters.fuente && filters.fuente !== 'todas' ? sqlEscape(filters.fuente) : null;

  // Sanitize filter values
  const cpvVal = filters.cpv ? sqlEscape(filters.cpv).replace(/[^0-9.]/g, '').slice(0, 10) : null;
  const estadoVal = filters.estado ? sqlEscape(filters.estado).slice(0, 100) : null;
  const nifVal = filters.nif ? sqlEscape(filters.nif).toUpperCase().slice(0, 20) : null;
  const desdeVal = validYear(filters.desde);
  const hastaVal = validYear(filters.hasta);
  const importeMinVal = validNumber(filters.importeMin);
  const importeMaxVal = validNumber(filters.importeMax);

  // Build WHERE clauses (pushdown) contra contratos_busqueda
  const localWhere: string[] = [];

  // Text search across objeto + organismo + adjudicatario.
  // Tokenized lax match: rows matching ANY term (>=3 chars) are returned;
  // relevance ordering is applied via _score in the outer ORDER BY.
  if (terms.length > 0) {
    const wordConds = terms.map(
      (t) =>
        `(contains(lower(objeto), '${t}') OR contains(lower(organismo), '${t}') OR contains(lower(COALESCE(adjudicatario,'')), '${t}'))`
    );
    localWhere.push(`(${wordConds.join(' OR ')})`);
  }

  // CPV — prefix match
  if (cpvVal) {
    localWhere.push(`cpv LIKE '${cpvVal}%'`);
  }

  // Importe — validated as numbers
  if (importeMinVal !== null) {
    localWhere.push(`importe_licitacion >= ${importeMinVal}`);
  }
  if (importeMaxVal !== null) {
    localWhere.push(`importe_licitacion <= ${importeMaxVal}`);
  }

  // Estado — escaped, ILIKE
  if (estadoVal) {
    localWhere.push(`estado ILIKE '%${estadoVal}%'`);
  }

  // NIF — exact match
  if (nifVal) {
    localWhere.push(`nif_adjudicatario = '${nifVal}'`);
  }

  // Year filters
  if (desdeVal) {
    localWhere.push(`fecha_publicacion >= '${desdeVal}-01-01'`);
  }
  if (hastaVal) {
    localWhere.push(`fecha_publicacion <= '${hastaVal}-12-31'`);
  }

  // Fuente: PLACSP incluye el histórico (PLACSP-hist); el resto filtra directo
  if (fuenteFilter) {
    const f = fuenteFilter.toLowerCase();
    if (f === 'place' || f === 'placsp') {
      localWhere.push(`(fuente = 'PLACE' OR fuente = 'PLACSP-hist')`);
    } else {
      localWhere.push(`lower(fuente) = '${f}'`);
    }
  }

  const whereStr = localWhere.length ? ' WHERE ' + localWhere.join(' AND ') : '';

  // Relevance score: number of query terms matched by this row. Projected
  // only when there are terms; stripped from client output by the explicit
  // outer column list.
  const scoreExpr = terms
    .map(
      (t) =>
        `(CASE WHEN contains(lower(objeto), '${t}') OR contains(lower(organismo), '${t}') OR contains(lower(COALESCE(adjudicatario,'')), '${t}') THEN 1 ELSE 0 END)`
    )
    .join(' + ');

  // Total/stable order: after the primary sort, break ties deterministically
  // on the projected columns `fuente` then `id` (both are always projected).
  // With free-text terms and no explicit sort, order by lexical relevance
  // (matched-term count) before recency. Otherwise keep the whitelist sort.
  const explicitSort = Boolean(filters.sort && validSortCols[filters.sort]);
  const orderBy =
    terms.length > 0 && !explicitSort
      ? 'ORDER BY _score DESC, fecha DESC NULLS LAST, fuente ASC, id ASC'
      : `ORDER BY ${sortCol} ${sortDir} ${nullsOrder}, fuente ASC, id ASC`;

  const dataSql = `SELECT id, fuente, expediente, organismo, objeto AS titulo, cpv, cpvs,
              importe_licitacion AS importe, importe_adjudicacion,
              fecha_publicacion AS fecha, fecha_fin, url,
              estado, adjudicatario, nif_adjudicatario AS nif_adj${
                terms.length ? `,\n              ${scoreExpr} AS _score` : ''
              }
           FROM contratos_busqueda${whereStr} ${orderBy} LIMIT ${limit + 1} OFFSET ${offset}`;
  const countSql = `SELECT -1 AS total`;

  return { dataSql, countSql, limit };
}

export { query } from './duckdb';