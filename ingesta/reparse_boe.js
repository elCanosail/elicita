#!/usr/bin/env node
/**
 * Re-parseo masivo de contratos BOE ya descargados.
 *
 * Lee ingesta/data/boe_contracts.json, vuelve a descargar el XML de cada
 * identificador y lo parsea con fetchAndParseItem del conector mejorado.
 *
 * Rate limit: lotes de 3 en paralelo, 1 s entre lotes.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'boe_contracts.json');
const TMP_FILE = path.join(__dirname, 'data', 'boe_contracts.json.tmp');
const LOG_FILE = path.join(__dirname, 'logs', 'reparse_boe.log');
const { fetchAndParseItem } = require('./connectors/boe');

const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 1000;
const SAVE_EVERY = 100;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function processContract(contract) {
  const rawId = String(contract.id || '').replace(/^BOE:/, '');
  if (!rawId) {
    log(`  ✗ ID vacío: ${JSON.stringify(contract.id)}`);
    return null;
  }

  const item = {
    identificador: rawId,
    titulo: contract.titulo || '',
    url_html: contract.url_fuente || `https://www.boe.es/diario_boe/txt.php?id=${rawId}`,
    fecha: contract.fecha_publicacion ? contract.fecha_publicacion.replace(/-/g, '') : '',
  };

  try {
    const parsed = await fetchAndParseItem(item);
    return parsed;
  } catch (err) {
    log(`  ✗ Error parseando ${rawId}: ${err.message}`);
    return null;
  }
}

async function main() {
  log('=== Inicio re-parseo BOE ===');

  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`No existe ${DATA_FILE}`);
  }

  const payload = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const contracts = payload.contratos || payload;
  const total = contracts.length;

  log(`Contratos a re-parsear: ${total}`);

  let processed = 0;
  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = contracts.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const results = await Promise.all(
      batch.map(async (contract) => {
        const parsed = await processContract(contract);
        return { contract, parsed };
      })
    );

    for (let j = 0; j < results.length; j++) {
      const { contract, parsed } = results[j];
      const idx = i + j;
      if (parsed) {
        contracts[idx] = parsed;
        enriched++;
        log(`  ✓ ${parsed.id} importe=${parsed.importe_licitacion || parsed.importe_adjudicacion || 0} adj=${parsed.adjudicatario ? 'S' : 'N'} fin=${parsed.fecha_fin || 'N'}`);
      } else {
        failed++;
      }
    }

    processed += batch.length;

    if (processed % SAVE_EVERY === 0 || processed === total) {
      const output = Array.isArray(payload) ? contracts : { ...payload, contratos: contracts };
      fs.writeFileSync(TMP_FILE, JSON.stringify(output, null, 2));
      fs.renameSync(TMP_FILE, DATA_FILE);
      log(`  💾 Progreso guardado: ${processed}/${total}`);
    }

    if (i + BATCH_SIZE < total) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  const output = Array.isArray(payload) ? contracts : { ...payload, contratos: contracts };
  fs.writeFileSync(TMP_FILE, JSON.stringify(output, null, 2));
  fs.renameSync(TMP_FILE, DATA_FILE);

  const withImporte = contracts.filter(c => (c.importe_licitacion || 0) > 0 || (c.importe_adjudicacion || 0) > 0).length;
  const withAdjudicatario = contracts.filter(c => !!c.adjudicatario).length;
  const withFechaFin = contracts.filter(c => !!c.fecha_fin).length;

  log('=== Resumen re-parseo BOE ===');
  log(`Total procesados:    ${processed}`);
  log(`Enriquecidos:          ${enriched}`);
  log(`Fallos:                ${failed}`);
  log(`Con importe:           ${withImporte}`);
  log(`Con adjudicatario:     ${withAdjudicatario}`);
  log(`Con fecha fin:         ${withFechaFin}`);

  console.log('\n=== Resumen re-parseo BOE ===');
  console.log(`Total procesados:    ${processed}`);
  console.log(`Enriquecidos:        ${enriched}`);
  console.log(`Fallos:              ${failed}`);
  console.log(`Con importe:         ${withImporte}`);
  console.log(`Con adjudicatario:   ${withAdjudicatario}`);
  console.log(`Con fecha fin:       ${withFechaFin}`);
}

main().catch(err => {
  log(`ERROR FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
});
