/**
 * Conector Madrid — Comunidad de Madrid / Contratación Pública
 *
 * Fuente: PLACE (Plataforma de contratación del Estado) con filtro geográfico Madrid
 * URL: https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom
 *
 * Estrategia:
 *   - El feed Atom de PLACE es cronológico inverso (más recientes primero)
 *   - Cada entry tiene <cbc:Name> = "Comunidad de Madrid" (u otras unidades)
 *   - Filtramos por <cbc:Name> que contenga "Madrid"
 *   - Paramos cuando la fecha supera DAYS_BACK
 *
 * Basado en la misma estrategia del conector DOGA (Galicia)
 *
 * NOTA sobre portales directos:
 *   - madrid.org tiene captcha en búsquedas → no accesible sin browser
 *   - BOCM no tiene feed de contratos
 *   - PLACE cubre todos los organismos de la CM por mandato legal
 */

'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const PLACE_FEED_BASE = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const DATA_FILE       = path.join(__dirname, '..', 'data', 'madrid_contracts.json');
const LOG_FILE        = path.join(__dirname, '..', 'logs', 'madrid.log');

const DAYS_BACK     = 30;
const MAX_PAGES     = 60;
const RATE_LIMIT_MS = 2000;

// Términos de CCAA y organismos de Madrid para filtrar
const MADRID_GEO_TERMS = [
  'comunidad de madrid',
  'madrid',
];

function log(msg) {
  const line = `[${new Date().toISOString()}] [madrid] ${msg}`;
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
      timeout : 45000,
      headers : {
        'User-Agent': 'Mozilla/5.0 (compatible; elicita-ingesta/1.0)',
        'Accept'    : 'application/atom+xml, application/xml, text/xml, */*',
      },
    };

    const req = lib.request(options, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
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

function extractAll(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

function extractFirst(xml, tag) {
  const all = extractAll(xml, tag);
  return all.length > 0 ? all[0] : '';
}

// Un entry es de Madrid si algún <cbc:Name> contiene "Madrid"
function isMadrid(entryXml) {
  const names = extractAll(entryXml, 'cbc:Name');
  return names.some(n => MADRID_GEO_TERMS.some(term =>
    n.toLowerCase().includes(term)
  ));
}

function extractCPVs(entryXml) {
  return extractAll(entryXml, 'cbc:ItemClassificationCode')
    .map(c => c.trim())
    .filter(Boolean);
}

function parseEntry(entry) {
  const title  = extractFirst(entry, 'title') || extractFirst(entry, 'cbc:Description');
  const linkM  = /<link[^>]+href="([^"]+)"/.exec(entry) ||
                 /<link>([^<]+)<\/link>/.exec(entry);
  const link   = linkM ? linkM[1] : '';
  const updated = extractFirst(entry, 'updated') || extractFirst(entry, 'cbc:IssueDate');
  const organismo = extractFirst(entry, 'cac:PartyName')
                 ? extractFirst(extractFirst(entry, 'cac:PartyName'), 'cbc:Name')
                 : '';
  const cpvs   = extractCPVs(entry);
  const importe = extractFirst(entry, 'cbc:TaxExclusiveAmount') ||
                  extractFirst(entry, 'cbc:EstimatedOverallContractAmount') || '';

  // ID del expediente
  const idM   = /id=([^&\s"]+)/i.exec(link) || /\/(\d{10,})\b/.exec(link);
  const id    = idM ? `MAD:${idM[1]}` : `MAD:${Date.now()}`;

  return {
    id,
    fuente          : 'MADRID',
    organismo       : organismo || 'Comunidad de Madrid',
    objeto          : title,
    cpv             : cpvs.join(', '),
    importe,
    fecha_publicacion: updated,
    estado          : 'publicado',
    url             : link,
  };
}

async function run() {
  log('Iniciando ingesta Madrid (via PLACE)...');
  const cutoff    = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;
  const contratos = [];
  let currentUrl  = PLACE_FEED_BASE;
  let page        = 0;

  while (currentUrl && page < MAX_PAGES) {
    log(`Página ${page}: ${currentUrl}`);
    let body;
    try {
      const res = await fetchUrl(currentUrl);
      if (res.statusCode !== 200) {
        log(`HTTP ${res.statusCode} — parando`);
        break;
      }
      body = res.body;
    } catch (err) {
      log(`ERROR en página ${page}: ${err.message}`);
      break;
    }

    // Extraer entries
    const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    let m;
    let hasOldEntries = false;

    while ((m = entryRe.exec(body)) !== null) {
      const entry   = m[1];
      const updated = extractFirst(entry, 'updated') || extractFirst(entry, 'cbc:IssueDate');
      const fecha   = updated ? new Date(updated).getTime() : 0;

      if (fecha && fecha < cutoff) {
        hasOldEntries = true;
        continue;
      }

      if (isMadrid(entry)) {
        contratos.push(parseEntry(entry));
      }
    }

    if (hasOldEntries) {
      log('Hay entries antiguas — parando paginación');
      break;
    }

    // Siguiente página
    const nextM = /<link[^>]+rel="next"[^>]+href="([^"]+)"/.exec(body) ||
                  /<link[^>]+href="([^"]+)"[^>]+rel="next"/.exec(body);
    currentUrl = nextM ? nextM[1] : null;
    page++;

    if (currentUrl) await sleep(RATE_LIMIT_MS);
  }

  log(`Total contratos Madrid: ${contratos.length}`);

  const output = {
    contratos,
    fuente              : 'MADRID',
    ultima_actualizacion: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2), 'utf8');
    log(`Guardados en ${DATA_FILE}`);
  } catch (err) {
    log(`ERROR al guardar: ${err.message}`);
  }

  return { total: contratos.length, contratos };
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(r => console.log(`Total Madrid: ${r.total}`))
    .catch(err => console.error('ERROR:', err.message));
}
