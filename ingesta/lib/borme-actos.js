'use strict';

/**
 * Espejo CJS de web/src/lib/borme.ts — mantiene las MISMAS reglas de
 * normalización y match (tests espejo en ambos lados: web con vitest, aquí
 * con node --test). Cualquier cambio de regla debe replicarse en ambos.
 *
 * Fase 2 del plan BORME (2026-10-14): actos registrales de los perfiles
 * seguidos (follows.proveedores, [{id: NIF, nombre}]) en el reporte semanal.
 *
 * Resolución idéntica a /perfil/[nif]: nif_canonical → fallback
 * adjudicatario en contratos_vivos → clave de comparación → IGUALDAD en SQL
 * (regexp_replace sin puntuación), nunca LIKE a ciegas.
 */

const SUFICIOS = new Set([
  'SL', 'SLU', 'SLE', 'SLP', 'SLL', 'SA', 'SAU', 'SAP', 'SC', 'SCA', 'SCL',
  'CB', 'AIE', 'UTE', 'SGR', 'EIRELL',
  'SOCIEDADLIMITADA', 'SOCIEDADANONIMA', 'SOCIEDADLABORAL', 'SOCIEDADCIVIL',
  'SOCIEDADCOMANDITARIA', 'COMANDITARIAPORACCIONES', 'COMANDITARIA',
  // sufijos multi-palabra del boletín ('… SOCIEDAD LIMITADA') y de segmentos
  // pegados por coma ('OCTAPHARMA,S.A.'), calibrado contra pares reales:
  'SOCIEDAD', 'LIMITADA', 'ANONIMA', 'LABORAL', 'CIVIL', 'COMANDITARIA',
  'COOPERATIVA', 'POR', 'ACCIONES', 'SCOOP', 'COOP', 'SRL', 'SRLU',
]);

function coreTok(tok) {
  return String(tok || '').replace(/[^A-Z0-9ÑÁÉÍÓÚÜ]/g, '');
}

/** Réplica de la regla upstream de `empresa_norm` (ver web/src/lib/borme.ts). */
function normalizeBormeName(name) {
  const up = String(name || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!up) return '';
  if (/UNIPERSONAL/.test(up)) return up;
  // Sufijos pegados por coma ('OCTAPHARMA,S.A.', 'FAES FARMA, S.L.U.', y la
  // coma final '… GENERAL S.L.,'): recorta segmentos finales cuyo núcleo sea
  // sufijo; segmentos vacíos (coma final) se descartan antes.
  const parts = up.split(',').filter((p) => p.trim() !== '');
  while (parts.length > 1 && SUFICIOS.has(coreTok(parts[parts.length - 1]))) parts.pop();
  const base = parts.join(',');
  // Sufijos finales por token ('… SOCIEDAD LIMITADA', '… SL', '… SA').
  const tokens = base.split(' ');
  const out = [...tokens];
  while (out.length > 1 && SUFICIOS.has(coreTok(out[out.length - 1]))) out.pop();
  return out.join(' ');
}

/** Clave de comparación: solo letras/números (comas y puntos de 'X, S.A.' fuera). */
function bormeMatchKey(name) {
  return normalizeBormeName(name).replace(/[^A-Z0-9ÑÁÉÍÓÚÜ]/g, '');
}

/** Predicado SQL simétrico a bormeMatchKey sobre empresa_norm. */
const MATCH_KEY_SQL = "regexp_replace(empresa_norm, '[^A-Za-z0-9ÑÁÉÍÓÚÜñáéíóúü]', '', 'g')";

/** Serializa fecha DuckDB (Date | 'YYYY-MM-DD…' | 'DD.MM.YY[.]') a ISO. */
function toIsoFecha(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2})\.?$/.exec(s);
  if (m) {
    const yy = parseInt(m[3], 10);
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/** URL del PDF oficial del boletín en boe.es (ver web/src/lib/borme.ts). */
function bormePdfUrl(pdfFilename, fecha) {
  if (!pdfFilename || !fecha) return null;
  const f = toIsoFecha(fecha);
  if (!f || !/^BORME-[A-Z]-/.test(pdfFilename)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f);
  if (!m) return null;
  return `https://www.boe.es/borme/dias/${m[1]}/${m[2]}/${m[3]}/pdfs/${pdfFilename}`;
}

/**
 * Actos registrales BORME de la ventana para los NIF seguidos.
 * queryFn(sql, params) → Promise<rows> (inyectada: queryLocalOrRest del
 * reporte; en tests, un fake). Devuelve:
 *   [{ nif, nombre, key, empresa, actos: [filas borme_empresas] }]
 * — solo NIF con match y con actos en la ventana.
 */
async function queryBormeActosSeguidos(queryFn, proveedores, startStr, endStr, opts = {}) {
  const maxPorProveedor = (opts && opts.maxPorProveedor) || 10;
  if (!Array.isArray(proveedores) || proveedores.length === 0) return [];
  const nifs = [...new Set(
    proveedores.map((p) => String((p && p.id) || '').trim().toUpperCase()).filter(Boolean),
  )];
  if (nifs.length === 0) return [];

  // 1) nombre canónico: nif_canonical (NIF → nombre), tabla del loader BORME.
  const names = new Map();
  try {
    const ph = nifs.map(() => '?').join(',');
    const rows = await queryFn(
      `SELECT UPPER(nif) AS nif, nombre FROM nif_canonical WHERE UPPER(nif) IN (${ph})`,
      nifs,
    );
    for (const r of rows || []) names.set(String(r.nif), r.nombre);
  } catch { /* la tabla puede no existir en una BD antigua */ }

  // 2) fallback: adjudicatario de contratos_vivos (mismo criterio que el perfil).
  const faltan = nifs.filter((n) => !names.has(n));
  if (faltan.length) {
    try {
      const ph = faltan.map(() => '?').join(',');
      const rows = await queryFn(
        `SELECT UPPER(nif_adjudicatario) AS nif, ANY_VALUE(adjudicatario) AS nombre
         FROM contratos_vivos
         WHERE UPPER(nif_adjudicatario) IN (${ph}) AND adjudicatario IS NOT NULL
         GROUP BY UPPER(nif_adjudicatario)`,
        faltan,
      );
      for (const r of rows || []) if (!names.has(String(r.nif))) names.set(String(r.nif), r.nombre);
    } catch { /* contratos no disponibles */ }
  }

  // 3) una query acotada por ventana por NIF resuelto.
  const resultados = [];
  for (const nif of nifs) {
    const nombre = names.get(nif);
    if (!nombre) continue;
    const key = bormeMatchKey(nombre);
    if (!key) continue;
    let actos = [];
    try {
      actos = await queryFn(
        `SELECT fecha_borme, num_entrada, empresa, empresa_norm, actos, domicilio,
                capital_euros, pdf_filename
         FROM borme_empresas
         WHERE fecha_borme >= ? AND fecha_borme <= ? AND ${MATCH_KEY_SQL} = ?
         ORDER BY fecha_borme DESC LIMIT ?`,
        [startStr, endStr, key, maxPorProveedor],
      );
    } catch { /* borme_empresas no disponible */ }
    if (actos && actos.length) {
      resultados.push({ nif, nombre, key, empresa: actos[0].empresa || null, actos });
    }
  }
  return resultados;
}

/**
 * Agrupa filas de borme_empresas por fecha desc:
 *   [{ fecha, empresa, actos: ['Nombramientos', …], pdfUrl }]
 * Cabeceras deduplicadas conservando el orden del boletín.
 */
function groupActosByDate(rows) {
  const porFecha = new Map();
  for (const r of rows || []) {
    const fecha = toIsoFecha(r.fecha_borme);
    if (!fecha) continue;
    if (!porFecha.has(fecha)) porFecha.set(fecha, []);
    porFecha.get(fecha).push(r);
  }
  return [...porFecha.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([fecha, items]) => ({
      fecha,
      empresa: (items[0] && items[0].empresa) || null,
      actos: [...new Set(items.flatMap((i) =>
        String(i.actos || '').split('|').map((s) => s.trim()).filter(Boolean),
      ))],
      pdfUrl: (items[0] && bormePdfUrl(items[0].pdf_filename, fecha)) || null,
    }));
}

module.exports = {
  normalizeBormeName,
  bormeMatchKey,
  toIsoFecha,
  bormePdfUrl,
  queryBormeActosSeguidos,
  groupActosByDate,
  MATCH_KEY_SQL,
};
