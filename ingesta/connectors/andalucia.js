/**
 * Conector Andalucía — Junta de Andalucía / Portal de Contratación Pública
 *
 * Fuente: Feed Atom oficial
 * URL: https://www.juntadeandalucia.es/haciendayadministracionpublica/apl/pdc-front-publico/feed/rssContratacionPublica
 *
 * Por qué funciona sin PinchTab:
 *   - El feed Atom es accesible con curl/https directamente (WAF permite feeds)
 *   - Contiene los contratos más recientes con organismo, importe, estado y fecha
 *   - Parseo XML del contenido del entry para extraer campos estructurados
 *
 * Nota: El portal principal (Angular SPA) sí bloquea curl directamente.
 *   El feed Atom es un endpoint separado no protegido por el WAF.
 */

'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');

const FEED_URL  = 'https://www.juntadeandalucia.es/haciendayadministracionpublica/apl/pdc-front-publico/feed/rssContratacionPublica';
const DATA_FILE = path.join(__dirname, '..', 'data', 'andalucia_contracts.json');
const LOG_FILE  = path.join(__dirname, '..', 'logs', 'andalucia.log');

const DAYS_BACK    = 30;
const RATE_LIMIT_MS = 2000;

function log(msg) {
  const line = `[${new Date().toISOString()}] [andalucia] ${msg}`;
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
        'Accept'    : 'application/atom+xml, application/xml, text/xml, */*',
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

// Extrae texto entre etiquetas XML sencillas
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m  = re.exec(xml);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim() : '';
}

// Extrae campo del contenido HTML embebido en el entry
function extractField(content, label) {
  const re = new RegExp(`<strong>\\s*${label}[\\s\\S]*?</strong>\\s*([^<]+)`, 'i');
  const m  = re.exec(content);
  return m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim() : '';
}

function parseFeed(xml) {
  const contratos = [];
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;

  // Split por entries
  const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const entry   = m[1];
    const title   = extractTag(entry, 'title');
    const linkM   = /<link[^>]+href="([^"]+)"/.exec(entry);
    const entryUrl = linkM ? linkM[1] : '';
    const updated = extractTag(entry, 'updated');
    const content = extractTag(entry, 'content');

    // Extraer fecha de publicación real del contenido HTML
    // (el campo `updated` del Atom es fecha de modificación del feed, no del contrato)
    const fechaPubRaw = extractField(content, 'Fecha de publicaci.n:');
    const fechaReal   = fechaPubRaw ? new Date(fechaPubRaw).getTime() : 0;
    const fechaRef    = fechaReal || (updated ? new Date(updated).getTime() : 0);

    // Filtro temporal: descartar contratos más antiguos que DAYS_BACK
    if (fechaRef && fechaRef < cutoff) continue;

    // Extraer campos del contenido HTML (ya extraídos arriba: fechaPubRaw)
    const organismo = extractField(content, 'Organo de contrataci.n:');
    const importe   = extractField(content, 'Importe:');
    const estado    = extractField(content, 'Estado:');
    const fechaPub  = fechaPubRaw;

    // Tipo de contrato
    const tipoM = extractField(content, 'Tipo de contrato:');

    // ID del expediente desde la URL
    const idM = /idExpediente=(\d+)/.exec(entryUrl);
    const id  = idM ? `AND:${idM[1]}` : `AND:${Date.now()}`;

    contratos.push({
      id,
      fuente           : 'ANDALUCIA',
      organismo        : organismo || 'Junta de Andalucía',
      objeto           : title,
      cpv              : '',  // No incluido en feed; disponible vía detalle
      importe          : importe || '',
      tipo_contrato    : tipoM || '',
      fecha_publicacion: fechaPub || updated || '',
      estado           : estado || 'publicado',
      url              : entryUrl,
    });
  }

  return contratos;
}

async function run() {
  log('Iniciando ingesta Andalucía...');

  let body;
  try {
    const res = await fetchUrl(FEED_URL);
    if (res.statusCode !== 200) {
      throw new Error(`HTTP ${res.statusCode}`);
    }
    body = res.body;
  } catch (err) {
    log(`ERROR al obtener feed: ${err.message}`);
    return { total: 0, contratos: [] };
  }

  const contratos = parseFeed(body);
  log(`Contratos encontrados: ${contratos.length}`);

  const output = {
    contratos,
    fuente             : 'ANDALUCIA',
    ultima_actualizacion: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    if (contratos.length > 0) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2), 'utf8');
    } else {
      log && log(`Sin contratos — manteniendo datos anteriores`);
    }
    log(`Guardados en ${DATA_FILE}`);
  } catch (err) {
    log(`ERROR al guardar: ${err.message}`);
  }

  return { total: contratos.length, contratos };
}

module.exports = { run };

// Ejecución directa
if (require.main === module) {
  run()
    .then(r => console.log(`Total Andalucía: ${r.total}`))
    .catch(err => console.error('ERROR:', err.message));
}
