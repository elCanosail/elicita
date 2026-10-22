/**
 * Conector Catalunya — Plataforma de Serveis de Contractació Pública (PSCP)
 *
 * Fuente: API REST oficial del portal
 * Endpoint: https://contractaciopublica.cat/portal-api/ultimes-publicacions
 *
 * Por qué funciona sin PinchTab:
 *   - El portal tiene una API REST pública sin autenticación
 *   - Se descubrió inspeccionando las llamadas de red del SPA Angular
 *   - Devuelve JSON paginado con los últimos anuncios publicados
 *   - tipus=104 = "Anunci de licitació en termini" (licitaciones abiertas)
 *
 * Nota: El portal principal carga lentamente (SPA Angular) pero la API
 *   backend responde en <200ms. Se evita completamente el browser.
 *
 * Campos disponibles en la API base:
 *   id, titol, dataPublicacio, nomOrgan, urlPublicacio
 * Nota: CPV e importe no están en el listado; requieren llamada al detalle
 *       (no implementado en v1 por rate-limit — se puede ampliar)
 */

'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const API_BASE  = 'https://contractaciopublica.cat/portal-api/ultimes-publicacions';
const DATA_FILE = path.join(__dirname, '..', 'data', 'catalunya_contracts.json');
const LOG_FILE  = path.join(__dirname, '..', 'logs', 'catalunya.log');

const DAYS_BACK     = 30;
const PAGE_SIZE     = 50;
const MAX_PAGES     = 10;   // máx 500 contratos
const RATE_LIMIT_MS = 2000; // pausa entre páginas

// tipus=104 = Anunci de licitació en termini (abierta)
// Se pueden añadir más tipos si se quiere cobertura más amplia
const TIPUS = 104;

function log(msg) {
  const line = `[${new Date().toISOString()}] [catalunya] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function fetchUrl(rawUrl) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(rawUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path    : parsed.pathname + parsed.search,
      method  : 'GET',
      timeout : 30000,
      headers : {
        'User-Agent': 'elicita-bot/1.0 (contratos@elicita.es)',
        'Accept'    : 'application/json',
      },
    };

    const req = lib.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(fetchUrl(res.headers.location));
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  log('Iniciando ingesta Catalunya...');
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;
  const contratos = [];
  let page = 0;
  let done = false;

  while (!done && page < MAX_PAGES) {
    const apiUrl = `${API_BASE}?page=${page}&size=${PAGE_SIZE}&tipus=${TIPUS}`;
    log(`Página ${page}: ${apiUrl}`);

    let data;
    try {
      const res = await fetchUrl(apiUrl);
      if (res.statusCode !== 200) {
        log(`ERROR HTTP ${res.statusCode} en página ${page}`);
        break;
      }
      data = JSON.parse(res.body);
    } catch (err) {
      log(`ERROR en página ${page}: ${err.message}`);
      break;
    }

    const items = data.content || [];
    if (!items.length) {
      log('No hay más resultados');
      break;
    }

    for (const item of items) {
      const fecha = new Date(item.dataPublicacio).getTime();
      if (fecha < cutoff) {
        done = true;
        break;
      }

      contratos.push({
        id              : `CAT:${item.id}`,
        fuente          : 'CATALUNYA',
        organismo       : item.nomOrgan || '',
        objeto          : item.titol || '',
        cpv             : '',   // No disponible en listado; requiere detalle
        importe         : '',   // No disponible en listado
        fecha_publicacion: item.dataPublicacio || '',
        estado          : 'publicado',
        url             : item.urlPublicacio || '',
      });
    }

    log(`Página ${page}: ${items.length} items, acumulados ${contratos.length}`);
    page++;

    if (data.last || page >= data.totalPages) break;
    await sleep(RATE_LIMIT_MS);
  }

  log(`Total contratos encontrados: ${contratos.length}`);

  if (contratos.length === 0) {
    log && log(`Sin contratos — manteniendo datos anteriores`);
    return { total: 0, contratos: [] };
  }

  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, contratos, { fuente: 'CATALUNYA', log });

  return { total: stats.total, contratos: [] };
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(r => console.log(`Total Catalunya: ${r.total}`))
    .catch(err => console.error('ERROR:', err.message));
}
