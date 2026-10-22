/**
 * Sitemap segmentado de los perfiles /perfil/<nif> (tarea 42).
 *
 * Genera en dist-staging/client/:
 *   - sitemaps/perfiles-<parte>.xml  (≤ 50.000 URLs/fichero, límite del protocolo)
 *   - sitemap-perfiles-index.xml     (índice que lista todos los segmentos)
 * robots.txt (en web/public) referencia el índice; post-build.mjs lo copia a dist.
 *
 * Población: NIFs distintos con ≥1 contrato — EXACTAMENTE la que resuelve
 * /perfil/[nif].astro (consulta `WHERE nif_adjudicatario = ?` sobre `calidad`
 * con fecha_publicacion IS NOT NULL).
 *
 * Política de emisión (espejo de web/src/lib/licitacion-url.ts, que no es
 * importable desde .mjs — mantener en paralelo, mismo criterio que
 * sitemap-licitaciones.mjs): RAW cuando el NIF es URL-safe, encodeURIComponent
 * en el resto. La página decodifica el param (patrón ficha, tarea 39) y
 * normaliza trim+toUpperCase antes de consultar → ambas formas resuelven.
 *
 * Servibilidad (medida contra BD 16-10-2026): la página normaliza con
 * trim+toUpperCase, así que solo son servibles los valores estables bajo
 * TRIM y UPPER (472.720 de 487.464). Los 14.744 excluidos son valores en
 * minúsculas (mayormente duplicados en mayúsculas ya emitidos, o inalcanzables
 * sin cambiar la semántica de la consulta — decisión de datos, fuera de
 * alcance): NO se emiten URLs que devolverían 200 con estado vacío.
 *
 * Degradación: sin BD (build en otra máquina) se omite la generación con aviso
 * y el build pasa. Guardas: total fuera de banda de cordura o
 * emitido + excluido ≠ total BD → throw (el build falla en voz alta, nunca se
 * publica un sitemap recortado sin querer).
 *
 * lastmod (tarea 53): cada <url> lleva <lastmod> = MAX(fecha_publicacion)
 * por NIF (xsd:date, agregado de la MISMA query de población — sin columnas
 * nuevas de tabla); cada <sitemap> del índice lleva el máximo del segmento.
 * Los <loc> y la contabilidad exacta quedan byte-idénticos — solo se AÑADE
 * <lastmod>.
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import duckdb from 'duckdb';

const DIST = 'dist-staging/client';
const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
const SITE = 'https://elicita.es';
const MAX_URLS_PER_FILE = 50_000; // límite del protocolo sitemaps.org
// Caracteres que viajan RAW por el path y llegan idénticos a Astro.params.
// DEBE seguir la misma definición que SAFE_ID en web/src/lib/licitacion-url.ts.
const SAFE_NIF = /^[A-Za-z0-9._!~*'():-]+$/;
// Banda de cordura del total distinto (anti-basura): el activo razonable hoy
// es ~0,5M y crece con la ingesta. Regulable por env si el operador lo necesita.
const MIN_TOTAL = parseInt(process.env.ELICITA_SITEMAP_PERFILES_MIN_TOTAL || '100000', 10);
const MAX_TOTAL = parseInt(process.env.ELICITA_SITEMAP_PERFILES_MAX_TOTAL || '5000000', 10);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function generateSitemapPerfiles() {
  if (!existsSync(DB_PATH)) {
    console.log(`  ⚠ [sitemap-perfiles] BD no disponible (${DB_PATH}) — build sin producción: generación omitida`);
    return;
  }

  const db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
  const conn = db.connect();
  conn.exec("SET memory_limit='2GB'; SET threads=2;");
  const q = (sql, params = []) =>
    new Promise((res, rej) => conn.all(sql, ...params, (e, r) => (e ? rej(e) : res(r))));

  try {
    // Población total: NIFs distintos con ≥1 contrato (la población que la
    // página puede consultar). No vacíos y con fecha publicada.
    const total = Number(
      (
        await q(
          `SELECT COUNT(DISTINCT nif_adjudicatario) AS n FROM calidad
           WHERE nif_adjudicatario IS NOT NULL AND TRIM(nif_adjudicatario) <> ''
             AND fecha_publicacion IS NOT NULL`
        )
      )[0].n
    );
    if (!Number.isFinite(total) || total < MIN_TOTAL || total > MAX_TOTAL) {
      throw new Error(
        `[sitemap-perfiles] total de NIFs fuera de banda de cordura: ${total} (permitido ${MIN_TOTAL}–${MAX_TOTAL}) — revisar antes de publicar el sitemap`
      );
    }

    // Servibles: estables bajo TRIM y UPPER (la página normaliza el param así;
    // un valor que cambia bajo esa normalización no es alcanzable por NINGUNA
    // URL — no se emiten URLs que devolverían 200 con estado vacío).
    // Tarea 53: GROUP BY (≡ DISTINCT en población) para añadir el agregado
    // MAX(fecha_publicacion) por NIF — el lastmod de cada <url>.
    const rows = await q(
      `SELECT nif_adjudicatario AS nif, strftime(MAX(fecha_publicacion), '%Y-%m-%d') AS ultima FROM calidad
       WHERE nif_adjudicatario IS NOT NULL AND TRIM(nif_adjudicatario) <> ''
         AND fecha_publicacion IS NOT NULL
         AND nif_adjudicatario = TRIM(nif_adjudicatario)
         AND nif_adjudicatario = UPPER(nif_adjudicatario)
       GROUP BY nif_adjudicatario
       ORDER BY nif`
    );

    const urls = [];
    const lastmods = [];
    for (const r of rows) {
      const nif = String(r.nif || '');
      if (!nif) continue; // defenses: ya filtrado en SQL, pero sin emisión vacía
      const path = SAFE_NIF.test(nif) ? `/perfil/${nif}` : `/perfil/${encodeURIComponent(nif)}`;
      // Tarea 53: lastmod = MAX(fecha_publicacion) del NIF (no nula: la población exige fecha).
      const ultima = String(r.ultima || '');
      urls.push(`  <url><loc>${SITE}${esc(path)}</loc>${ultima ? `<lastmod>${ultima}</lastmod>` : ''}</url>`);
      lastmods.push(ultima);
    }
    const emitted = urls.length;
    const excluded = total - emitted;
    if (emitted + excluded !== total) {
      throw new Error(
        `[sitemap-perfiles] contabilidad rota: emitido (${emitted}) + excluido (${excluded}) ≠ total BD (${total}) — build abortado`
      );
    }
    if (emitted !== rows.length) {
      throw new Error(
        `[sitemap-perfiles] filas BD (${rows.length}) ≠ URLs construidas (${emitted}) — ¿filas con nif vacío tras el filtro? — build abortado`
      );
    }

    // Los segmentos de fichas ya viven en sitemaps/ (tarea 38): los de perfiles
    // conviven en el mismo directorio con prefijo propio. Purga dirigida de
    // perfiles-*.xml obsoletos (si un build anterior emitió más segmentos) sin
    // tocar los lit-*.
    const perfilesDir = join(DIST, 'sitemaps');
    mkdirSync(perfilesDir, { recursive: true });
    for (const f of readdirSync(perfilesDir)) {
      if (/^perfiles-\d+\.xml$/.test(f)) unlinkSync(join(perfilesDir, f));
    }

    const files = [];
    const parts = Math.ceil(emitted / MAX_URLS_PER_FILE);
    for (let p = 0; p < parts; p++) {
      const chunk = urls.slice(p * MAX_URLS_PER_FILE, (p + 1) * MAX_URLS_PER_FILE);
      // Tarea 53: lastmod del segmento = máximo de sus URLs (xsd:date: orden lexicográfico).
      const maxMod = lastmods
        .slice(p * MAX_URLS_PER_FILE, (p + 1) * MAX_URLS_PER_FILE)
        .reduce((a, b) => (b > a ? b : a), '');
      const name = `perfiles-${p + 1}.xml`;
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        chunk.join('\n') +
        `\n</urlset>\n`;
      writeFileSync(join(perfilesDir, name), xml);
      // Guarda por fichero: el XML emitido contiene exactamente las URLs construidas
      const urlCount = (xml.match(/<url>/g) || []).length;
      if (urlCount !== chunk.length) {
        throw new Error(`[sitemap-perfiles] ${name}: ${urlCount} <url> emitidas ≠ ${chunk.length} construidas`);
      }
      files.push({ name, lastmod: maxMod });
    }

    // Índice de sitemaps (límite del protocolo: 50.000 sitemaps/índice)
    if (files.length > 50_000) {
      throw new Error(`[sitemap-perfiles] ${files.length} ficheros superan el límite del índice de sitemaps`);
    }
    const index =
      `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      files
        .map(
          (f) =>
            `  <sitemap><loc>${SITE}/sitemaps/${f.name}</loc>${f.lastmod ? `<lastmod>${f.lastmod}</lastmod>` : ''}</sitemap>`
        )
        .join('\n') +
      `\n</sitemapindex>\n`;
    writeFileSync(join(DIST, 'sitemap-perfiles-index.xml'), index);

    console.log(
      `  ✓ [sitemap-perfiles] ${emitted} URLs emitidas (${files.length} sitemaps de ≤${MAX_URLS_PER_FILE.toLocaleString('es-ES')}) · ${excluded} excluidas (no servibles: valores no estables bajo trim/upper — la página normaliza) · población BD ${total} exacta`
    );
  } finally {
    try { conn.close(); } catch { /* noop */ }
    try { db.close(); } catch { /* noop */ }
  }
}
