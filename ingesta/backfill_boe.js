/**
 * Backfill histórico BOE — Sección V.A Contratación del Sector Público
 *
 * Descarga sumarios diarios desde una fecha inicio hasta hoy,
 * extrae todos los items de sección 5A, hace fetch+parse de cada XML,
 * y los guarda en boe_contracts.json (merge con existentes).
 *
 * Uso:
 *   node ingesta/backfill_boe.js --from=20240101 [--to=20260622] [--rate=1000]
 *
 * Características:
 *   - Resumible: salta IDs ya en cache
 *   - Rate limit configurable (default 1000ms entre lotes)
 *   - Paralelismo: 3 XMLs en paralelo
 *   - Guarda progreso cada 200 contratos
 *   - Estadísticas al final
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BOE_API_BASE = 'https://www.boe.es/datosabiertos/api/boe/sumario';
const DATA_FILE = path.join(__dirname, '..', 'data', 'boe_contracts.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'boe_backfill.log');

const PARALLEL_BATCH = 3;
const BATCH_DELAY = 1000; // ms entre lotes
const XML_TIMEOUT = 15000;
const MAX_RETRIES = 2;
const SAVE_EVERY = 200;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchUrl(url, retries = MAX_RETRIES, accept = 'application/json', timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, {
        headers: {
          'User-Agent': 'ElicitaBot/1.0 (ingesta@elicita.es)',
          'Accept': accept,
        },
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `https://www.boe.es${res.headers.location}`;
          return fetchUrl(redirectUrl, retries, accept, timeoutMs).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });
      req.on('error', (err) => {
        if (n > 1) { sleep(2000).then(() => attempt(n - 1)).catch(reject); }
        else reject(err);
      });
      req.on('timeout', () => {
        req.destroy();
        if (n > 1) { sleep(1000).then(() => attempt(n - 1)).catch(reject); }
        else reject(new Error('Timeout'));
      });
    };
    attempt(retries);
  });
}

// Generar todos los días hábiles entre dos fechas
function getWorkdays(from, to) {
  const dates = [];
  const start = new Date(from);
  const end = new Date(to);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      dates.push(`${y}${m}${day}`);
    }
  }
  return dates;
}

async function fetchSumarioItems(fecha) {
  const url = `${BOE_API_BASE}/${fecha}`;
  let data;
  try {
    const raw = await fetchUrl(url, MAX_RETRIES, 'application/json', 15000);
    data = JSON.parse(raw);
  } catch (err) {
    log(`  ✗ Sumario ${fecha}: ${err.message}`);
    return [];
  }

  if (data.status?.code !== '200') {
    log(`  ✗ Sumario ${fecha}: status ${data.status?.code}`);
    return [];
  }

  const items = [];
  const diarios = data.data?.sumario?.diario;
  const diariosArr = Array.isArray(diarios) ? diarios : (diarios ? [diarios] : []);

  for (const diario of diariosArr) {
    const secciones = diario.seccion;
    const seccionesArr = Array.isArray(secciones) ? secciones : (secciones ? [secciones] : []);

    for (const seccion of seccionesArr) {
      if (seccion.codigo !== '5A') continue;

      const deps = seccion.departamento;
      const depsArr = Array.isArray(deps) ? deps : (deps ? [deps] : []);

      for (const dep of depsArr) {
        const directItems = dep.item ? (Array.isArray(dep.item) ? dep.item : [dep.item]) : [];
        const epigrafes = dep.epigrafe ? (Array.isArray(dep.epigrafe) ? dep.epigrafe : [dep.epigrafe]) : [];

        let allItems = [...directItems];
        for (const ep of epigrafes) {
          const epItems = ep.item ? (Array.isArray(ep.item) ? ep.item : [ep.item]) : [];
          allItems = allItems.concat(epItems);
        }

        for (const item of allItems) {
          if (!item.identificador) continue;
          items.push({
            identificador: item.identificador,
            titulo: item.titulo || '',
            url_html: item.url_html || `https://www.boe.es/diario_boe/txt.php?id=${item.identificador}`,
            fecha,
          });
        }
      }
    }
  }

  return items;
}

// Cargar el conector para usar fetchAndParseItem
const boeModule = { exports: {} };
const boeCode = fs.readFileSync(path.join(__dirname, 'connectors', 'boe.js'), 'utf-8');
const wrappedCode = boeCode.replace(
  'module.exports = { run };',
  'module.exports = { run, fetchAndParseItem };'
);
const wrapper = new Function('module', 'exports', 'require', '__dirname', '__filename', wrappedCode);
wrapper(boeModule, boeModule.exports, require, __dirname, __filename);
const { fetchAndParseItem } = boeModule.exports;

function saveData(contratos, total) {
  const data = {
    total: contratos.length,
    lastUpdate: new Date().toISOString(),
    contratos,
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  let from = null, to = null;
  for (const arg of args) {
    if (arg.startsWith('--from=')) from = arg.split('=')[1];
    if (arg.startsWith('--to=')) to = arg.split('=')[1];
  }

  if (!from) {
    console.error('Uso: node backfill_boe.js --from=YYYYMMDD [--to=YYYYMMDD]');
    process.exit(1);
  }

  const toDate = to || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fromDate = `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}`;
  const toDateFmt = `${toDate.slice(0, 4)}-${toDate.slice(4, 6)}-${toDate.slice(6, 8)}`;

  log(`=== Backfill BOE ${fromDate} → ${toDateFmt} ===`);

  // Cargar cache
  let cachedIds = new Set();
  let contratos = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      contratos = existing.contratos || [];
      cachedIds = new Set(contratos.map(c => c.id));
      log(`Cache: ${cachedIds.size} contratos ya procesados`);
    } catch (_) {}
  }

  // Generar días hábiles
  const workdays = getWorkdays(fromDate, toDateFmt);
  log(`Días hábiles a procesar: ${workdays.length}`);

  let nuevosCount = 0;
  let errorCount = 0;
  let totalItems = 0;

  for (let di = 0; di < workdays.length; di++) {
    const fecha = workdays[di];
    log(`→ [${di + 1}/${workdays.length}] Sumario ${fecha}`);

    const items = await fetchSumarioItems(fecha);
    totalItems += items.length;
    log(`  5A items: ${items.length}`);

    if (items.length === 0) { await sleep(300); continue; }

    // Filtrar duplicados
    const filtrados = items.filter(item => {
      const id = `BOE:${item.identificador}`;
      if (cachedIds.has(id)) return false;
      cachedIds.add(id);
      return true;
    });

    log(`  Nuevos: ${filtrados.length} de ${items.length}`);

    if (filtrados.length === 0) { await sleep(300); continue; }

    // Procesar en lotes
    for (let i = 0; i < filtrados.length; i += PARALLEL_BATCH) {
      const chunk = filtrados.slice(i, i + PARALLEL_BATCH);
      const results = await Promise.allSettled(
        chunk.map(item => fetchAndParseItem(item))
      );

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled' && results[j].value) {
          contratos.push(results[j].value);
          nuevosCount++;
        } else if (results[j].status === 'rejected') {
          errorCount++;
          log(`  ✗ Error: ${results[j].reason?.message}`);
        }
      }

      if (i + PARALLEL_BATCH < filtrados.length) {
        await sleep(BATCH_DELAY);
      }
    }

    // Guardar progreso periódicamente
    if (nuevosCount > 0 && nuevosCount % SAVE_EVERY < PARALLEL_BATCH) {
      saveData(contratos, contratos.length);
      log(`  💾 Guardado progreso: ${contratos.length} total, ${nuevosCount} nuevos`);
    }

    await sleep(300);
  }

  // Guardar final
  saveData(contratos, contratos.length);

  // Estadísticas
  const conImporte = contratos.filter(c => c.importe_licitacion > 0 || c.importe_adjudicacion > 0).length;
  const conAdj = contratos.filter(c => c.adjudicatario).length;
  const conFechaFin = contratos.filter(c => c.fecha_fin).length;
  const licitaciones = contratos.filter(c => c.estado === 'abierta').length;
  const formalizaciones = contratos.filter(c => c.estado === 'formalizada').length;

  log(`\n=== BACKFILL COMPLETO ===`);
  log(`Días procesados: ${workdays.length}`);
  log(`Items 5A totales: ${totalItems}`);
  log(`Nuevos contratos: ${nuevosCount}`);
  log(`Errores: ${errorCount}`);
  log(`Total en cache: ${contratos.length}`);
  log(`Licitaciones: ${licitaciones} | Formalizaciones: ${formalizaciones}`);
  log(`Con importe > 0: ${conImporte}`);
  log(`Con adjudicatario: ${conAdj}`);
  log(`Con fecha fin: ${conFechaFin}`);
  log(`=== FIN ===\n`);
}

main().catch(err => {
  log(`ERROR FATAL: ${err.message}`);
  process.exit(1);
});