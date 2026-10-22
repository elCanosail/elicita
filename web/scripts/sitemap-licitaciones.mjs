/**
 * Sitemap segmentado de las fichas /licitacion/<fuente>/<id> (tarea 38).
 *
 * Genera en dist-staging/client/:
 *   - sitemaps/lit-<YYYY-MM>[-<parte>].xml  (≤ 50.000 URLs/fichero, límite del protocolo)
 *   - sitemap-lit-index.xml                 (índice que lista todos los segmentos)
 * robots.txt (en web/public) referencía el índice; post-build.mjs lo copia a dist.
 *
 * Población: EXACTAMENTE la que sirven las fichas — `SELECT ... FROM contratos_vivos`
 * (la página [fuente]/[id].astro resuelve con `WHERE fuente = ? AND id = ?`).
 * Segmentación por mes de fecha_publicacion (recency discovery).
 *
 * Codificación (tarea 39 — política única con web/src/lib/licitacion-url.ts):
 * la ficha DECODIFICA los params (Astro no lo hace) y responde 404 real en
 * no-encontrada → hoy TODA la población es servible. Emisión normalizada:
 * RAW cuando fuente/id son URL-safe (identidad — sin churn en las URLs ya
 * publicadas), encodeURIComponent en el resto (la ficha decodifica %2F/%3A/…
 * y consolida duplicados vía canonical con esta misma forma).
 *
 * Degradación: sin BD (build en otra máquina) se omite la generación con aviso
 * y el build pasa. Guardas: total fuera de banda de cordura o
 * emitido ≠ total BD → throw (el build falla en voz alta, nunca se
 * publica un sitemap recortado sin querer).
 *
 * lastmod (tarea 53): cada <url> lleva <lastmod> = fecha_publicacion
 * (xsd:date, la MISMA columna que segmenta — sin datetime ni columnas
 * nuevas); cada <sitemap> del índice lleva el máximo del segmento. Los
 * <loc> y la contabilidad exacta quedan byte-idénticos — solo se AÑADE
 * <lastmod>.
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import duckdb from 'duckdb';

const DIST = 'dist-staging/client';
const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
const SITE = 'https://elicita.es';
const MAX_URLS_PER_FILE = 50_000; // límite del protocolo sitemaps.org
// Caracteres que pueden ir RAW en el <loc> y llegar idénticos a Astro.params
// (id === encodeURIComponent(id) salvo ':' que también viaja raw sin problema —
// sondeo 2026-10-14). Lo fuera de este conjunto no es servible hoy: se excluye.
const SAFE_ID = /^[A-Za-z0-9._!~*'():-]+$/;
const SAFE_FUENTE = /^[A-Za-z0-9._!~*'()-]+$/;
// Banda de cordura del total (anti-basura): el activo razonable hoy es ~0,6M
// y crece ~60-70K/mes. Regulable por env si el operador lo necesita.
const MIN_TOTAL = parseInt(process.env.ELICITA_SITEMAP_MIN_TOTAL || '100000', 10);
const MAX_TOTAL = parseInt(process.env.ELICITA_SITEMAP_MAX_TOTAL || '20000000', 10);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nextMonth = (mes) => {
  const [y, m] = mes.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

export async function generateSitemapLicitaciones() {
  if (!existsSync(DB_PATH)) {
    console.log(`  ⚠ [sitemap-licitaciones] BD no disponible (${DB_PATH}) — build sin producción: generación omitida`);
    return;
  }

  const db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
  const conn = db.connect();
  conn.exec("SET memory_limit='2GB'; SET threads=2;");
  const q = (sql, params = []) =>
    new Promise((res, rej) => conn.all(sql, ...params, (e, r) => (e ? rej(e) : res(r))));

  try {
    const total = Number((await q('SELECT COUNT(*) AS n FROM contratos_vivos'))[0].n);
    if (!Number.isFinite(total) || total < MIN_TOTAL || total > MAX_TOTAL) {
      throw new Error(
        `[sitemap-licitaciones] total de contratos_vivos fuera de banda de cordura: ${total} (permitido ${MIN_TOTAL}–${MAX_TOTAL}) — revisar antes de publicar el sitemap`
      );
    }

    const meses = (
      await q(
        `SELECT strftime(fecha_publicacion, '%Y-%m') AS mes, COUNT(*) AS n
         FROM contratos_vivos
         WHERE fecha_publicacion IS NOT NULL
         GROUP BY mes ORDER BY mes`
      )
    ).map((r) => ({ mes: r.mes, n: Number(r.n) }));

    const sitemapsDir = join(DIST, 'sitemaps');
    rmSync(sitemapsDir, { recursive: true, force: true });
    mkdirSync(sitemapsDir, { recursive: true });

    const files = [];
    let emitted = 0;
    let excluded = 0;

    for (const { mes, n } of meses) {
      const parts = Math.ceil(n / MAX_URLS_PER_FILE);
      let mesEmitted = 0;
      for (let p = 0; p < parts; p++) {
        const rows = await q(
          `SELECT fuente, id, strftime(fecha_publicacion, '%Y-%m-%d') AS ultima FROM contratos_vivos
           WHERE fecha_publicacion >= ? AND fecha_publicacion < ?
           ORDER BY fuente, id
           LIMIT ? OFFSET ?`,
          [`${mes}-01`, nextMonth(mes), MAX_URLS_PER_FILE, p * MAX_URLS_PER_FILE]
        );
        const urls = [];
        let maxUltima = '';
        for (const r of rows) {
          const f = String(r.fuente || '');
          const id = String(r.id || '');
          if (!f || !id) continue;
          // Política tarea 39 (espejo de lib/licitacion-url.ts — no importable
          // desde .mjs): RAW si safe, encoded si no. La ficha decodifica ambos.
          const path =
            SAFE_FUENTE.test(f) && SAFE_ID.test(id)
              ? `/licitacion/${f}/${id}`
              : `/licitacion/${encodeURIComponent(f)}/${encodeURIComponent(id)}`;
          // Tarea 53: lastmod = fecha_publicacion (no nula por el WHERE del
          // segmento — la misma columna que segmenta).
          const ultima = String(r.ultima || '');
          if (ultima > maxUltima) maxUltima = ultima; // xsd:date: orden lexicográfico
          urls.push(`  <url><loc>${SITE}${esc(path)}</loc>${ultima ? `<lastmod>${ultima}</lastmod>` : ''}</url>`);
        }
        excluded += rows.length - urls.length;
        if (urls.length === 0) continue; // segmento sin servibles: sin fichero
        const name = parts > 1 ? `lit-${mes}-${p + 1}.xml` : `lit-${mes}.xml`;
        const xml =
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          urls.join('\n') +
          `\n</urlset>\n`;
        writeFileSync(join(sitemapsDir, name), xml);
        // Guarda por fichero: el XML emitido contiene exactamente las URLs construidas
        const urlCount = (xml.match(/<url>/g) || []).length;
        if (urlCount !== urls.length) {
          throw new Error(`[sitemap-licitaciones] ${name}: ${urlCount} <url> emitidas ≠ ${urls.length} construidas`);
        }
        emitted += urls.length;
        mesEmitted += urls.length;
        files.push({ name, lastmod: maxUltima });
      }
      const tag = files.length && mesEmitted > 0 ? ` → ${mesEmitted} URLs` : ' → 0 servibles';
      console.log(`  · [sitemap-licitaciones] ${mes}: ${n} filas${tag}`);
    }

    if (emitted + excluded !== total) {
      throw new Error(
        `[sitemap-licitaciones] contabilidad rota: emitido (${emitted}) + excluido (${excluded}) ≠ contratos_vivos (${total}) — build abortado`
      );
    }
    if (excluded !== 0) {
      throw new Error(
        `[sitemap-licitaciones] política tarea 39: emisión normalizada de TODA la población — excluidas ${excluded} ≠ 0 (¿filas con fuente/id vacíos en BD?) — build abortado`
      );
    }

    // Índice de sitemaps (límite del protocolo: 50.000 sitemaps/índice — estamos ~2 órdenes por debajo)
    if (files.length > 50_000) {
      throw new Error(`[sitemap-licitaciones] ${files.length} ficheros superan el límite del índice de sitemaps`);
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
    writeFileSync(join(DIST, 'sitemap-lit-index.xml'), index);

    console.log(
      `  ✓ [sitemap-licitaciones] ${emitted} URLs emitidas (${files.length} sitemaps, ${meses.length} meses) · ${excluded} excluidas · emitido = ${total} exacto (política normalizada tarea 39)`
    );
  } finally {
    try { conn.close(); } catch { /* noop */ }
    try { db.close(); } catch { /* noop */ }
  }
}
