/**
 * Conector Euskadi v2 — Open Data Euskadi JSON anuales
 *
 * Fuente: opendata.euskadi.eus/contenidos/ds_contrataciones/contrataciones_admin_{año}/opendata/contratos.json
 * Total disponible: 704K+ contratos (2011-2026)
 *
 * ESTRATEGIA v3:
 *   - Descarga JSON anual a archivo temporal
 *   - Streaming JSON parse con Obvious-JS-Streaming approach:
 *     1. Descargar archivo completo (130-220MB)
 *     2. Leer por chunks y buscar objetos completos {..} por depth tracking
 *     3. Filtro por fecha DURANTE el parseo
 *   - Heap del proceso hijo: 2GB (suficiente para el JSON completo + parse)
 *   - Timeout del scheduler: 900s (el ciclo completo medía ~271.8s y creciendo)
 *   - Caché de año cerrado: el JSON anual anterior se guarda y reutiliza si el
 *     Content-Length del HEAD coincide (fail-open; ~421 → ~205 MB/ciclo)
 *
 * NOTA: El JSON anual es un array simple [{...},{...},...]
 * que se puede parsear objeto por objeto con regex/división
 * ya que los objetos no tienen {..} anidados problemáticos.
 *
 * Ref: DECISIONS.md D013
 */

'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'euskadi_contracts.json');
const LOG_FILE  = path.join(__dirname, '..', 'logs', 'euskadi_v2.log');
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');

const DAYS_BACK = 30;
const BASE_URL  = 'https://opendata.euskadi.eus/contenidos/ds_contrataciones';

function yearUrl(year, baseUrl = BASE_URL) {
  return `${baseUrl}/contrataciones_admin_${year}/opendata/contratos.json`;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] [euskadi_v2] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchUrl(rawUrl, opts = {}) {
  const { timeout = 600000 } = opts;
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port    : parsed.port || undefined,
      path    : parsed.pathname + parsed.search,
      method  : 'GET',
      timeout,
      headers : {
        'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept'         : 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Referer'        : 'https://opendata.euskadi.eus/',
      },
    };

    const req = lib.request(options, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location, opts).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Caché de año cerrado (fail-open) ────────────────────────────────────
// Un año cerrado no cambia: re-descargar su JSON (~217 MB) cada ciclo es
// innecesario. Guardamos el cuerpo + metadatos con su Content-Length y lo
// reutilizamos solo si el HEAD upstream coincide. Si algo no cuadra (sin
// caché, HEAD falla, tamaño distinto) se cae a la descarga normal.
function cachePaths(year, cacheDir = CACHE_DIR) {
  return {
    data: path.join(cacheDir, `euskadi-${year}.json`),
    meta: path.join(cacheDir, `euskadi-${year}.meta.json`),
  };
}

function contentLengthFrom(headers, body) {
  const raw = headers && (headers['content-length'] || headers['Content-Length']);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : Buffer.byteLength(body, 'utf8');
}

function readCacheMeta(year, cacheDir) {
  try {
    return JSON.parse(fs.readFileSync(cachePaths(year, cacheDir).meta, 'utf8'));
  } catch (_) {
    return null;
  }
}

function headContentLength(rawUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port    : parsed.port || undefined,
      path    : parsed.pathname + parsed.search,
      method  : 'HEAD',
      timeout : 30000,
      headers : {
        'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept'         : 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Referer'        : 'https://opendata.euskadi.eus/',
      },
    };

    const req = lib.request(options, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return headContentLength(res.headers.location).then(resolve, reject);
      }
      const n = parseInt(res.headers['content-length'], 10);
      resolve({ statusCode: res.statusCode, contentLength: Number.isFinite(n) && n > 0 ? n : null });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function loadClosedYearBody(year, { baseUrl = BASE_URL, cacheDir = CACHE_DIR } = {}) {
  let cachedBody;
  try {
    cachedBody = fs.readFileSync(cachePaths(year, cacheDir).data, 'utf8');
  } catch (_) {
    return null; // sin caché — descarga normal
  }

  const meta = readCacheMeta(year, cacheDir);
  if (!meta || !meta.contentLength) {
    log(`  Año ${year}: caché sin metadatos — re-descargando`);
    return null;
  }

  let upstream;
  try {
    upstream = await headContentLength(yearUrl(year, baseUrl));
  } catch (err) {
    log(`  Año ${year}: HEAD falló (${err.message}) — re-descargando`);
    return null;
  }

  if (upstream.statusCode !== 200 || !upstream.contentLength) {
    log(`  Año ${year}: HEAD HTTP ${upstream.statusCode} — re-descargando`);
    return null;
  }

  if (upstream.contentLength !== meta.contentLength) {
    log(`  Año ${year}: upstream cambió (${meta.contentLength} → ${upstream.contentLength} bytes) — re-descargando`);
    return null;
  }

  log(`  Año ${year}: cacheado (skip)`);
  return cachedBody;
}

function saveClosedYearBody(year, body, contentLength, { cacheDir = CACHE_DIR } = {}) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const { data, meta } = cachePaths(year, cacheDir);
    const tmpData = `${data}.tmp`;
    fs.writeFileSync(tmpData, body);
    fs.renameSync(tmpData, data);

    const tmpMeta = `${meta}.tmp`;
    fs.writeFileSync(tmpMeta, JSON.stringify({
      year,
      contentLength,
      sizeBytes: Buffer.byteLength(body, 'utf8'),
      fetchedAt: new Date().toISOString(),
    }));
    fs.renameSync(tmpMeta, meta);
    log(`  Año ${year}: caché guardada (${(Buffer.byteLength(body, 'utf8') / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    log(`  Año ${year}: aviso — no se pudo guardar caché (${err.message})`);
  }
}

function fetchXml(rawUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path    : parsed.pathname + parsed.search,
      method  : 'GET',
      timeout : 15000,
      headers : {
        'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept'         : 'application/xml, text/xml, */*',
        'Accept-Language': 'es-ES,es;q=0.9',
      },
    };

    const req = lib.request(options, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchXml(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const body = buf.toString('latin1');
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function parseImporteEuskadi(str) {
  if (!str) return 0;
  const normalized = String(str)
    .replace(/\./g, '')     // separador de miles
    .replace(/,/g, '.');    // separador decimal
  return parseFloat(normalized) || 0;
}

function parseAdjudicacion(xml) {
  if (!xml) return null;

  // 1) Precio sin IVA
  const priceMatch = xml.match(/<priceWithoutVAT[^>]*>([^<]+)<\/priceWithoutVAT>/i);
  const importe = priceMatch ? parseImporteEuskadi(priceMatch[1]) : 0;

  // 2) Adjudicatario y CIF: preferir licitorCompany dentro de adjInfo
  let businessName = '';
  let cif = '';

  const licitorMatch = xml.match(/<licitorCompany>[\s\S]*?<\/licitorCompany>/i);
  if (licitorMatch) {
    const licitor = licitorMatch[0];
    const nameMatch = licitor.match(/<businessName[^>]*>([^<]+)<\/businessName>/i);
    const cifMatch  = licitor.match(/<businessCif[^>]*>([^<]+)<\/businessCif>/i);
    businessName = nameMatch ? nameMatch[1].trim() : '';
    cif = cifMatch ? cifMatch[1].trim() : '';
  }

  // Fallback a formalization si no hay licitorCompany
  if (!businessName) {
    const formalizationMatch = xml.match(/<formalization>[\s\S]*?<\/formalization>/i);
    if (formalizationMatch) {
      const formalization = formalizationMatch[0];
      const nameMatch = formalization.match(/<businessName[^>]*>([^<]+)<\/businessName>/i);
      const cifMatch  = formalization.match(/<id desc="CIF"[^>]*>([^<]+)<\/id>/i) ||
                        formalization.match(/<id[^>]*>([^<]+)<\/id>/i);
      businessName = nameMatch ? nameMatch[1].trim() : '';
      cif = cifMatch ? cifMatch[1].trim() : '';
    }
  }

  if (!importe && !businessName) return null;

  return {
    importe_adjudicacion    : importe,
    importe_adjudicacion_str: normImporte(importe),
    adjudicatario           : businessName,
    cif_adjudicatario       : cif,
  };
}

async function enrichAdjudicados(contratos, concurrency = 10) {
  const adjudicados = contratos.filter(c => c.estado === 'adjudicada' && c._dataXML);
  if (adjudicados.length === 0) {
    log('Enriquecimiento: 0 contratos adjudicados con dataXML en ventana');
    return { enriched: 0, total: 0 };
  }

  log(`Enriquecimiento: ${adjudicados.length} contratos adjudicados, ${concurrency} paralelos`);

  let enriched = 0;
  let processed = 0;

  async function processBatch(batch) {
    const results = await Promise.all(batch.map(async c => {
      try {
        const res = await fetchXml(c._dataXML);
        if (res.statusCode !== 200 || !res.body) {
          log(`  XML error ${res.statusCode} para ${c.id}`);
          return null;
        }
        const parsed = parseAdjudicacion(res.body);
        if (!parsed) return null;

        Object.assign(c, parsed);
        return parsed.adjudicatario || parsed.importe_adjudicacion ? c.id : null;
      } catch (err) {
        log(`  XML fallo ${c.id}: ${err.message}`);
        return null;
      }
    }));

    for (const id of results) {
      processed++;
      if (id) enriched++;
    }
  }

  const start = Date.now();
  const timeoutMs = 300000; // 5 min total
  for (let i = 0; i < adjudicados.length; i += concurrency) {
    if (Date.now() - start > timeoutMs) {
      log(`Enriquecimiento: timeout total alcanzado tras ${processed}/${adjudicados.length}`);
      break;
    }
    const batch = adjudicados.slice(i, i + concurrency);
    await processBatch(batch);
    if ((i / concurrency) % 10 === 0) {
      log(`  Progreso enriquecimiento: ${processed}/${adjudicados.length}`);
    }
  }

  log(`Enriquecidos ${enriched}/${adjudicados.length} contratos con datos de adjudicación`);
  return { enriched, total: adjudicados.length };
}

function parseDate(str) {
  if (!str) return null;
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  const d = m ? new Date(`${m[3]}-${m[2]}-${m[1]}`) : new Date(str);
  // Invalid Date pasa checks de falsy — normalizar a null
  return isNaN(d.getTime()) ? null : d;
}

function normEstado(estado) {
  if (!estado) return 'desconocido';
  const s = estado.toLowerCase();
  if (s.includes('adjudic')) return 'adjudicada';
  if (s.includes('resuel')) return 'resuelta';
  if (s.includes('formaliz')) return 'formalizada';
  if (s.includes('abierta') || s.includes('licitaci')) return 'abierta';
  if (s.includes('publicad')) return 'publicado';
  if (s.includes('evaluaci')) return 'evaluacion';
  if (s.includes('anulad')) return 'anulada';
  return estado.toLowerCase();
}

function normImporte(val) {
  const n = parseFloat(val) || 0;
  if (!n) return '—';
  if (n >= 1e9) return `€ ${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `€ ${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `€ ${Math.round(n/1e3)}K`;
  return `€ ${Math.round(n)}`;
}

function mapContrato(src, idx) {
  const exp = src.contratacion_expediente || '';
  const id  = `EUS:${exp || idx}`;
  const fechaStr = src.contratacion_fecha_de_publicacion_documento || src.creationDate || '';
  const fecha = parseDate(fechaStr);
  const fechaISO = fecha ? fecha.toISOString().substring(0, 10) : '';
  const fechaFinStr = src.contratacion_fecha_limite_presentacion || '';
  const fechaFin = parseDate(fechaFinStr);
  const fechaFinISO = fechaFin ? fechaFin.toISOString().substring(0, 10) : '';

  // CPV: usar contratacion_tipo_contrato y contratacion_materia_contrato como sustituto
  let cpv = '';
  const tipo = src.contratacion_tipo_contrato || '';
  const materia = src.contratacion_materia_contrato || '';
  if (materia) cpv = materia;
  else if (tipo) cpv = tipo;

  return {
    id              : id,
    titulo          : src.contratacion_titulo_contrato || src.documentName || '',
    objeto          : src.contratacion_objeto_contrato || src.contratacion_titulo_contrato || src.documentName || '',
    organismo       : src.contratacion_poder_adjudicador_titulo || src.institution || src.contratacion_entidad_impulsora || 'Gobierno Vasco',
    cpv             : cpv,
    cpvs            : [],
    importe         : normImporte(src.contratacion_precio_licitacion || 0),
    importe_num     : parseFloat(src.contratacion_precio_licitacion) || 0,
    estado          : normEstado(src.contratacion_estado_tramitacion || ''),
    fecha_publicacion: fechaISO,
    fecha_fin       : fechaFinISO,
    fuente          : 'Euskadi',
    adjudicatario   : '',
    importe_adjudicacion    : 0,
    importe_adjudicacion_str: '—',
    cif_adjudicatario       : '',
    url             : src.friendlyUrl || src.physicalUrl || '',
    _fuente_file    : 'euskadi',
    expediente      : exp,
    _dataXML        : src.dataXML || '',
  };
}

/**
 * Streaming parse de un JSON anual usando archivo temporal.
 *
 * En vez de cargar el JSON completo en memoria (130-220MB → OOM),
 * descargamos a archivo y usamos readline para procesar línea por línea.
 * Los objetos JSON de Euskadi están pretty-printed (un key por línea),
 * así que podemos identificar los límites de cada objeto por el patrón
 * de llaves { } con depth tracking.
 *
 * Memoria pico: ~50MB (solo objetos en ventana, no el JSON completo).
 */
async function fetchYearStreaming(year, cutoff, opts = {}) {
  const baseUrl  = opts.baseUrl  || BASE_URL;
  const cacheDir = opts.cacheDir || CACHE_DIR;
  const url = yearUrl(year, baseUrl);
  log(`  Descargando año ${year}...`);

  try {
    let body = null;

    // Step 1: año cerrado con caché válida → skip descarga (fail-open)
    if (opts.useCache) {
      body = await loadClosedYearBody(year, { baseUrl, cacheDir });
    }

    if (body === null) {
      const res = await fetchUrl(url);
      if (res.statusCode !== 200) {
        log(`  HTTP ${res.statusCode} para ${year} — omitiendo`);
        return [];
      }

      const sizeMB = (res.body.length / 1024 / 1024).toFixed(1);
      log(`  Año ${year}: descargado ${sizeMB} MB`);
      body = res.body;

      if (opts.useCache) {
        saveClosedYearBody(year, body, contentLengthFrom(res.headers, body), { cacheDir });
      }
    }

    // Step 2: Parse entire array with JSON.parse (we have the data in memory)
    // This works because we're in a forked process with 2GB heap
    log(`  Año ${year}: parseando JSON...`);
    // Algunos años (2014-2019) devuelven JSONP: jsonCallback([ ... ]); — strip wrapper
    if (/^\s*\w+\s*\(/.test(body)) {
      const start = body.indexOf('[');
      const end = body.lastIndexOf(']');
      if (start !== -1 && end > start) {
        body = body.substring(start, end + 1);
        log(`  Año ${year}: JSONP detectado — wrapper eliminado`);
      }
    }
    const data = JSON.parse(body);
    if (!Array.isArray(data)) {
      log(`  Año ${year}: formato inesperado — no es array`);
      return [];
    }
    log(`  Año ${year}: ${data.length} registros totales`);

    // Step 3: Filter by date
    const contratos = [];
    for (let i = 0; i < data.length; i++) {
      const src = data[i];
      const fechaStr = src.contratacion_fecha_de_publicacion_documento || src.creationDate || '';
      const fecha = parseDate(fechaStr);
      if (!fecha || fecha < cutoff) continue;

      const c = mapContrato(src, contratos.length);
      // Solo filtrar si objeto es literally vacio (no 'Sin título' que puede ser válido)
      if (c.objeto && c.objeto.trim()) {
        contratos.push(c);
      }
    }

    log(`  Año ${year}: ${contratos.length} contratos en ventana`);

    // Free memory
    data.length = 0;

    return contratos;
  } catch (err) {
    log(`  ERROR ${year}: ${err.message}`);
    return [];
  }
}

async function run() {
  log('=== Iniciando Euskadi v2 (Download+Parse v3) ===');

  const cutoff = new Date(Date.now() - DAYS_BACK * 86400000);
  log(`Ventana: últimos ${DAYS_BACK} días (desde ${cutoff.toISOString().substring(0, 10)})`);

  const currentYear = new Date().getFullYear();
  const yearsToFetch = [currentYear, currentYear - 1];

  const contratos = [];

  for (const year of yearsToFetch) {
    // Año cerrado (anterior al actual): reutilizar caché si el upstream no cambió
    const items = await fetchYearStreaming(year, cutoff, { useCache: year < currentYear });
    contratos.push(...items);
    log(`  Año ${year}: ${items.length} contratos en ventana (acumulado: ${contratos.length})`);
    // Force GC between years to free memory from previous year's JSON
    if (global.gc) global.gc();
  }

  log(`Total Euskadi v2: ${contratos.length} contratos en los últimos ${DAYS_BACK} días`);

  if (contratos.length > 0) {
    await enrichAdjudicados(contratos, 10);
  }

  // Limpiar campo interno _dataXML antes de mergear (lo usan contratos no procesados también)
  for (const c of contratos) {
    delete c._dataXML;
  }

  if (contratos.length === 0) {
    log('Sin contratos — manteniendo datos anteriores');
    return { total: 0, contratos: [] };
  }

  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, contratos, {
    fuente: 'EUSKADI_V2',
    meta: { metodo: 'download_parse' },
    log,
    skipPurge: true, // Euskadi mantiene histórico completo — sin purga (las demás fuentes purgan normal)
  });

  return { total: stats.total };
}

if (require.main === module) {
  // Modo backfill: node euskadi_v2.js --backfill [--from=2011] [--to=2023]
  if (process.argv.includes('--backfill')) {
    const arg = (name, def) => {
      const a = process.argv.find(x => x.startsWith(`--${name}=`));
      return a ? parseInt(a.split('=')[1], 10) : def;
    };
    backfill({ from: arg('from', 2011), to: arg('to', new Date().getFullYear() - 3), dryRun: process.argv.includes('--dry-run') })
      .then(r => console.log(`✓ Euskadi v2 backfill: ${r.total} contratos`))
      .catch(err => console.error('Error backfill:', err));
  } else {
    run()
      .then(r => console.log(`✓ Euskadi v2: ${r.total} contratos`))
      .catch(err => console.error('Error:', err));
  }
}

/**
 * Backfill histórico: descarga años completos SIN cutoff y los mergea
 * con retención extendida (los adjudicados viejos no se purgan en el
 * siguiente ciclo normal porque merge usa MAX_AGE sobre fecha_updated,
 * que el merge actualiza). Para conservar el histórico se marca cada
 * contrato como terminal (adjudicado/resuelto mantiene 730 días) y el
 * backfill debe re-ejecutarse tras cada purga si se quiere perpetuo.
 */
async function backfill({ from, to, dryRun = false }) {
  log(`=== BACKFILL Euskadi ${from}-${to} ===`);
  const contratos = [];
  for (let year = from; year <= to; year++) {
    // cutoff null = sin filtro de fecha
    const items = await fetchYearStreaming(year, null);
    contratos.push(...items);
    log(`  Año ${year}: ${items.length} contratos (acumulado: ${contratos.length})`);
    if (global.gc) global.gc();
  }
  log(`Total backfill: ${contratos.length} contratos`);
  if (dryRun || contratos.length === 0) {
    return { total: contratos.length };
  }
  for (const c of contratos) delete c._dataXML;
  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, contratos, {
    fuente: 'EUSKADI_V2',
    meta: { metodo: 'download_parse_backfill' },
    log,
    skipPurge: true,
  });
  return { total: stats.total };
}

module.exports = { run, backfill };
// Superficie interna para verificación local (no usada en producción)
module.exports._test = { fetchYearStreaming, loadClosedYearBody, saveClosedYearBody, cachePaths, yearUrl };