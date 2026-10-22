#!/usr/bin/env node
/**
 * generar-rankings-organismos.mjs — regenera los rankings de organismos
 * (importe y volumen) desde la BD en modo READ-ONLY.
 *
 * Procedencia: los JSON actuales (8c4b83e, 06-07, "rankings regenerados con
 * datos saneados") se publicaron sin el script generador y con la clave
 * `organismo`, que no coincide con la que leen las plantillas
 * (`item.nombre`, organismos-importe.astro:63 / organismos-volumen.astro:55)
 * — la columna Organismo, la identidad de cada fila, se sirve VACÍA en las
 * 2 páginas desde entonces. Este script restaura el contrato de datos
 * original (5fa336e: nombre/contratos/total) y lo vuelve reproducible por
 * primera vez. Gemelo del fix de adjudicatarios de la tarea 48.
 *
 * Reglas de saneado (espejo del generador de adjudicatarios, tarea 48):
 *  - Deduplicación por `id`: 1 fila por id, priorizando estado terminal
 *    (Resuelta > Formalizada > Adjudicada > resto) y luego importe DESC.
 *  - Importes absurdos (>5.000 M€) excluidos con contabilidad.
 *  - Entidad = el propio organismo (valor BD TRIM). Sin NIF ni enlaces a
 *    /perfil — los organismos no tienen perfil.
 *  - Contrato de datos: se emite la clave `nombre` — NO se emite `organismo`
 *    ni se tocan las plantillas.
 *
 * Población: `contratos_busqueda` — la misma tabla materializada que usan el
 * generador de adjudicatarios (tarea 48), la API de búsqueda, fichas y
 * perfiles. Desviación documentada de la spec: la expectativa «top1 volumen
 * ~1,6M ct (Xunta de Galicia)» heredaba el JSON de 06-07, generado contra el
 * corpus completo de entonces (view contratos_unificados sobre tablas que el
 * esquema actual ya no expone; GALICIA tiene 40.741 filas en la tabla viva,
 * no 1,7M). Medido contra la BD viva del 21-10: top1 volumen = Universidad
 * de Murcia (139.366), Xunta 1.660. El ranking sirve la población que el
 * producto realmente atiende — la misma decisión de población que la tarea
 * 48 documentó para adjudicatarios («datos no comparables con el JSON
 * previo»).
 *
 * Uso: node scripts/generar-rankings-organismos.mjs
 * Degradación: sin BD (build en otra máquina) el script falla en voz alta —
 * los JSON versionados siguen siendo válidos hasta la siguiente regeneración.
 * Guardas: bandas de cordura por ranking; fuera de banda → exit 1 (nunca se
 * publica un ranking recortado sin querer).
 *
 * Determinismo (tarea 54, espejo del generador de adjudicatarios): la
 * agregación es SUM en céntimos enteros (CAST ... AS BIGINT — asociativa,
 * inmune al orden de combinación paralelo de threads=2; magnitud ~1e14
 * céntimos « 2^53, exacta en float64 al dividir) en lugar de SUM float
 * (wobble del último decimal entre corridas). Los sorts JS llevan
 * tie-breakers deterministas (importe: total DESC → contratos DESC → nombre
 * ASC; volumen: contratos DESC → total DESC → nombre ASC) comparando por
 * code points, NUNCA localeCompare (depende de la versión de ICU). La dedup
 * ROW_NUMBER resuelve empates de (estado, importe) con org_entidad ASC: el
 * orden de entrada del GROUP BY hash de DuckDB no es estable entre corridas.
 * Dos corridas sobre la misma BD producen JSON byte-idénticos.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import duckdb from 'duckdb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
const OUT_DIR = join(__dirname, '..', 'src', 'data');

const LIMITE = 50;                 // top N por ranking (contrato con las plantillas)
const IMPORTE_ABSURDO = 5e9;       // >5.000 M€ por fila (regla saneado 8c4b83e)
const MIN_FILAS_ORG = 4_000_000;   // banda de cordura: filas con organismo
const MAX_FILAS_ORG = 6_000_000;
const MIN_TOP1_IMPORTE = 2e10;     // el nº1 por importe (DGAM): entre 20.000 y 60.000 M€
const MAX_TOP1_IMPORTE = 6e10;
const MIN_TOP1_CONTRATOS = 50_000; // el nº1 por volumen: entre 50.000 y 500.000 (medido 21-10: 139.366)
const MAX_TOP1_CONTRATOS = 500_000;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
const conn = db.connect();
conn.exec("SET memory_limit='2GB'; SET threads=2;");
const q = (sql) => new Promise((res, rej) => conn.all(sql, (e, r) => (e ? rej(e) : res(r))));

try {
  // 1. Base saneada y agregada por entidad (organismo TRIM).
  const rows = await q(`
    WITH base AS (
      SELECT * FROM (
        SELECT
          id, estado, importe_adjudicacion,
          TRIM(organismo) AS org_entidad,
          fecha_publicacion,
          ROW_NUMBER() OVER (
            PARTITION BY id
            ORDER BY CASE estado
                       WHEN 'Resuelta' THEN 0
                       WHEN 'Formalizada' THEN 1
                       WHEN 'Adjudicada' THEN 2
                       ELSE 3
                     END,
                     importe_adjudicacion DESC,
                     org_entidad ASC
          ) AS rn
        FROM contratos_busqueda
        WHERE organismo IS NOT NULL AND TRIM(organismo) <> ''
          AND (importe_adjudicacion IS NULL OR importe_adjudicacion <= ${IMPORTE_ABSURDO})
      ) WHERE rn = 1
    )
    SELECT
      org_entidad,
      COUNT(*) AS contratos,
      SUM(CASE WHEN importe_adjudicacion > 0
               THEN CAST(ROUND(importe_adjudicacion * 100) AS BIGINT)
               ELSE 0 END) AS total_centimos,
      strftime(MAX(fecha_publicacion), '%Y-%m-%d') AS fecha_corte
    FROM base
    GROUP BY org_entidad
  `);

  const filasOrg = rows.reduce((acc, r) => acc + Number(r.contratos), 0);
  if (!(filasOrg >= MIN_FILAS_ORG && filasOrg <= MAX_FILAS_ORG)) {
    throw new Error(`[rankings] filas con organismo fuera de banda de cordura: ${filasOrg} (permitido ${MIN_FILAS_ORG}–${MAX_FILAS_ORG})`);
  }

  // Contabilidad de exclusión: filas con organismo vacío o importe absurdo.
  const excl = await q(`
    SELECT COUNT(*)::BIGINT AS n FROM contratos_busqueda
    WHERE (organismo IS NULL OR TRIM(organismo) = '')
       OR importe_adjudicacion > ${IMPORTE_ABSURDO}
  `);
  console.log(`[rankings] filas excluidas (organismo vacío o importe absurdo): ${Number(excl[0].n)}`);

  const aJson = (r) => ({
    nombre: esc(r.org_entidad),
    contratos: Number(r.contratos),
    // Céntimos enteros exactos (SUM BIGINT) / 100: la división única en
    // float64 es determinista. NUNCA Number(...).toFixed(2) sobre un SUM
    // float paralelo — ahí vivía el wobble del último decimal.
    total: Number(r.total_centimos) / 100,
  });

  // Comparación por code points (NO localeCompare: depende de la ICU).
  const cmpCodePoints = (a, b) => {
    if (a === b) return 0;
    const A = Array.from(a);
    const B = Array.from(b);
    const n = Math.min(A.length, B.length);
    for (let i = 0; i < n; i++) {
      const ca = A[i].codePointAt(0);
      const cb = B[i].codePointAt(0);
      if (ca !== cb) return ca - cb;
    }
    return A.length - B.length;
  };

  // Tie-breakers deterministas: la entrada del GROUP BY hash de DuckDB no es
  // estable entre corridas (threads=2) — los empates se resuelven aquí.
  const porImporte = rows
    .filter((r) => Number(r.total_centimos) > 0)
    .sort((a, b) =>
      Number(b.total_centimos) - Number(a.total_centimos) ||
      Number(b.contratos) - Number(a.contratos) ||
      cmpCodePoints(String(a.org_entidad), String(b.org_entidad))
    )
    .slice(0, LIMITE)
    .map(aJson);
  const porVolumen = rows
    .sort((a, b) =>
      Number(b.contratos) - Number(a.contratos) ||
      Number(b.total_centimos) - Number(a.total_centimos) ||
      cmpCodePoints(String(a.org_entidad), String(b.org_entidad))
    )
    .slice(0, LIMITE)
    .map(aJson);

  // 3. Guardas de cordura por ranking.
  if (porImporte.length !== LIMITE) throw new Error(`[rankings] importe: ${porImporte.length} filas ≠ ${LIMITE}`);
  if (porVolumen.length !== LIMITE) throw new Error(`[rankings] volumen: ${porVolumen.length} filas ≠ ${LIMITE}`);
  const top1Importe = porImporte[0].total;
  if (!(top1Importe >= MIN_TOP1_IMPORTE && top1Importe <= MAX_TOP1_IMPORTE)) {
    throw new Error(`[rankings] top1 importe fuera de banda: ${top1Importe} (permitido ${MIN_TOP1_IMPORTE}–${MAX_TOP1_IMPORTE})`);
  }
  const top1Contratos = porVolumen[0].contratos;
  if (!(top1Contratos >= MIN_TOP1_CONTRATOS && top1Contratos <= MAX_TOP1_CONTRATOS)) {
    throw new Error(`[rankings] top1 contratos fuera de banda: ${top1Contratos} (permitido ${MIN_TOP1_CONTRATOS}–${MAX_TOP1_CONTRATOS})`);
  }
  for (const [nombre, lista] of [['importe', porImporte], ['volumen', porVolumen]]) {
    for (const item of lista) {
      if (!item.nombre || !Number.isFinite(item.contratos) || !Number.isFinite(item.total)) {
        throw new Error(`[rankings] ${nombre}: fila con campos vacíos: ${JSON.stringify(item)}`);
      }
    }
  }

  // 4. Escritura atómica (temp + rename), solo los dos JSON del contrato.
  const out1 = join(OUT_DIR, 'rankings-organismos.json');
  const out2 = join(OUT_DIR, 'rankings-organismos-volumen.json');
  for (const [path, data] of [[out1, porImporte], [out2, porVolumen]]) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    const { renameSync, statSync } = await import('node:fs');
    renameSync(tmp, path);
    const kb = (statSync(path).size / 1024).toFixed(1);
    console.log(`[rankings] ${path} — ${data.length} filas, ${kb} KB`);
  }

  // 4-bis. Meta de frescura de la familia (tarea 56, espejo del generador de
  // adjudicatarios): fecha de datos y de regeneración a la vista en las
  // plantillas (firma FARO «cada cifra lleva fuente, fecha y checksum”).
  // fecha_corte = MAX(fecha_publicacion) de la población base (máximo de los
  // máximos por grupo — MAX es asociativo); generado_utc rota en cada
  // regeneración: es trazabilidad, no ruido. Escritura atómica igual que los
  // rankings; degradación sin BD idéntica (falla en voz alta antes de
  // escribir — la meta versionada sigue válida).
  const meta = {
    generado_utc: new Date().toISOString(),
    fecha_corte: rows.reduce((m, r) => (r.fecha_corte > m ? r.fecha_corte : m), ''),
    filas_base: filasOrg,
    excluidas: Number(excl[0].n),
    top1: {
      nombre: porImporte[0].nombre,
      contratos: porImporte[0].contratos,
      total: porImporte[0].total,
    },
  };
  const outMeta = join(OUT_DIR, 'rankings-organismos-meta.json');
  const tmpMeta = `${outMeta}.tmp`;
  writeFileSync(tmpMeta, JSON.stringify(meta, null, 2) + '\n');
  const { renameSync: rsMeta } = await import('node:fs');
  rsMeta(tmpMeta, outMeta);
  console.log(`[rankings] ${outMeta} — fecha_corte ${meta.fecha_corte}, filas_base ${meta.filas_base}`);

  console.log(`[rankings] filas con organismo (post-dedup): ${filasOrg}`);
  console.log(`[rankings] top1 importe: ${porImporte[0].nombre} = ${porImporte[0].total} € · ${porImporte[0].contratos} contratos`);
  console.log(`[rankings] top1 volumen: ${porVolumen[0].nombre} = ${porVolumen[0].contratos} contratos`);
  console.log('[rankings] OK');
  process.exit(0);
} catch (e) {
  console.error('[rankings] ERROR:', e.message);
  process.exit(1);
} finally {
  db.close();
}
