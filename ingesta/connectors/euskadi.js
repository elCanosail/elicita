/**
 * Conector Euskadi — KontratazioA / Plataforma de Contratación del País Vasco
 *
 * Fuente: API REST oficial de Open Data Euskadi (KontratazioA)
 * Referencia: https://opendata.euskadi.eus/webopd00-apicontract/es/?api=procurements
 *
 * La plataforma publicó en 2024 una API REST oficial con datos de contratación.
 * Esta API es open data, sin autenticación.
 *
 * Estrategia:
 *   1. Llamar al endpoint de búsqueda de licitaciones con filtro de fecha
 *   2. Paginar si hay más resultados
 *   3. Guardar en data/euskadi_contracts.json
 *
 * Nota: Si la API de opendata no devuelve datos estructurados directamente,
 *   se cae back a búsqueda via PinchTab del portal tradicional.
 *   El portal https://www.contratacion.euskadi.eus/inicio/ bloquea el RSS
 *   antiguo pero es navegable con browser headless.
 *
 * FALLBACK con PinchTab: Si API REST no responde correctamente,
 *   el conector documenta el error y devuelve array vacío (CERO datos inventados).
 */

'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'euskadi_contracts.json');
const LOG_FILE  = path.join(__dirname, '..', 'logs', 'euskadi.log');

const DAYS_BACK     = 30;
const PAGE_SIZE     = 100;
const MAX_PAGES     = 20;
const RATE_LIMIT_MS = 1000;

// API REST oficial de Open Data Euskadi (KontratazioA)
// Spec OpenAPI: https://opendata.euskadi.eus/contenidos/recurso_tecnico/data_apirest/es_def/adjuntos/procurements.json
// Base URL: https://api.euskadi.eus
// Endpoint licitaciones: GET /procurements/contracting-notices
const API_BASE = 'https://api.euskadi.eus/procurements/contracting-notices';

// Búsqueda del portal antiguo (Atom/RSS) — fallback
const FEED_URL = 'https://www.contratacion.euskadi.eus/w32-kpelink/es/contenidos/anuncio_contratacion/licitaciones_abiertas/es_doc/rss.xml';

function log(msg) {
  const line = `[${new Date().toISOString()}] [euskadi] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function fetchUrl(rawUrl, accept) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(rawUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path    : parsed.pathname + parsed.search,
      method  : 'GET',
      timeout : 30000,
      headers : {
        'User-Agent': 'Mozilla/5.0 (compatible; elicita-ingesta/1.0)',
        'Accept'    : accept || 'application/json',
      },
    };

    // api.euskadi.eus usa certificado de CA vasca (IZENPE) no incluida en
    // el bundle por defecto de Node.js — desactivar verificación SSL
    options.rejectUnauthorized = false;

    const req = lib.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc && !loc.includes(rawUrl)) return resolve(fetchUrl(loc, accept));
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

// Fecha en formato ISO para filtro API
function dateNDaysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

// Llama a la API REST oficial de KontratazioA paginando
// Endpoint: GET /procurements/contracting-notices?pageSize=N&pageNumber=N
// Filtra por fecha de publicación >= hoy - DAYS_BACK
async function tryApiRest() {
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;
  const contratos = [];
  let page = 0;
  let done = false;

  while (!done && page <= MAX_PAGES) {
    const apiUrl = `${API_BASE}?pageSize=${PAGE_SIZE}&pageNumber=${page}`;
    log(`Página ${page}: ${apiUrl}`);

    let data;
    try {
      const res = await fetchUrl(apiUrl);
      if (res.statusCode !== 200) {
        log(`API HTTP ${res.statusCode} — parando`);
        break;
      }
      data = JSON.parse(res.body);
    } catch (err) {
      log(`ERROR API página ${page}: ${err.message}`);
      break;
    }

    const items = data.items || [];
    if (!items.length) break;

    for (const item of items) {
      const fechaStr = item.firstPublicationDate || item.lastPublicationDate || '';
      const fecha = fechaStr ? new Date(fechaStr).getTime() : 0;
      if (fecha && fecha < cutoff) { done = true; break; }

      // Organismo: priorizar contractingAuthority.name, luego entity.name
      const organismo = item.contractingAuthority?.name ||
                        item.entity?.name ||
                        item.procedureCollection || 'Gobierno Vasco';

      // Objeto: fallback chain — object, code, id
      const objeto    = item.object || item.code || `Expediente ${item.id}` || '';

      // CPV: usar cpvCodes si disponible, si no usar contractType.name como sustituto
      const cpvList = item.cpvCodes || item.cpvCode || [];
      let cpv = '';
      if (Array.isArray(cpvList) && cpvList.length) {
        cpv = cpvList.map(c => c.code || c.name || c).join(', ');
      } else if (item.contractType?.name) {
        cpv = item.contractType.name; // 'Servicios', 'Suministros', 'Obras', etc.
      }

      // Importe: estimatedValue puede ser null (común en Euskadi)
      const importe = item.estimatedValue || item.amount || '';

      // Estado: usar contractProcedureStatus si disponible
      const procStatus = item.contractProcedureStatus?.name || '';
      let estado = 'publicado';
      if (procStatus) {
        const s = procStatus.toLowerCase();
        if (s.includes('adjudic')) estado = 'adjudicada';
        else if (s.includes('formaliz')) estado = 'formalizada';
        else if (s.includes('abierta') || s.includes('licit')) estado = 'abierta';
        else estado = procStatus.toLowerCase();
      }

      // Fecha límite: deadlineDate si disponible
      const fechaFin = item.deadlineDate || '';

      // NIF del adjudicatario
      const adjudicatario = item.contractingAuthority?.identificationNumber || '';

      contratos.push({
        id              : `EUS:${item.id || item.code || Date.now()}`,
        fuente          : 'EUSKADI',
        organismo,
        objeto,
        cpv,
        cpvs            : cpvList || [],
        importe,
        importe_num     : parseFloat(importe) || 0,
        fecha_publicacion: fechaStr,
        fecha_fin       : fechaFin,
        estado,
        expediente      : item.code || String(item.id || ''),
        adjudicatario,
        url             : item.mainEntityOfPage ||
                          item._links?.self?.href ||
                          `https://www.contratacion.euskadi.eus/`,
      });
    }

    log(`Página ${page}: ${items.length} items, acumulados ${contratos.length}`);
    if (data.currentPage >= data.totalPages) break;
    page++;
    await sleep(RATE_LIMIT_MS);
  }

  return contratos.length > 0 ? contratos : null;
}

// Parsea el feed Atom del portal antiguo (si está disponible)
function parseFeedAtom(xml) {
  const contratos = [];
  const cutoff    = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;
  const entryRe   = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const entry = m[1];
    const title = (/<title[^>]*>([^<]+)/.exec(entry) || [])[1] || '';
    const link  = (/<link[^>]*>([^<]+)/.exec(entry) || [])[1] || '';
    const pubDate = (/<pubDate[^>]*>([^<]+)/.exec(entry) || [])[1] || '';
    const desc  = (/<description[^>]*>([\s\S]*?)<\/description>/.exec(entry) || [])[1] || '';

    const fecha = pubDate ? new Date(pubDate).getTime() : 0;
    if (fecha && fecha < cutoff) continue;

    // Extraer organismo del description
    const orgM = /<td[^>]*>\s*([^<]{5,100})\s*<\/td>/.exec(desc);

    contratos.push({
      id              : `EUS:${encodeURIComponent(title.slice(0,30))}:${Date.now()}`,
      fuente          : 'EUSKADI',
      organismo       : orgM ? orgM[1].trim() : 'Gobierno Vasco / Admin. Foral',
      objeto          : title.trim(),
      cpv             : '',
      importe         : '',
      fecha_publicacion: pubDate || '',
      estado          : 'publicado',
      url             : link.trim(),
    });
  }
  return contratos;
}

async function run() {
  log('Iniciando ingesta Euskadi...');
  let contratos = [];

  // Intento 1: API REST oficial api.euskadi.eus/procurements
  const apiData = await tryApiRest();
  if (apiData && apiData.length) {
    contratos.push(...apiData);
    log(`API REST devolvió ${contratos.length} contratos`);
  }

  // Intento 2: Fallback al feed RSS/Atom antiguo
  if (!contratos.length) {
    log('Intentando fallback feed antiguo...');
    try {
      await sleep(RATE_LIMIT_MS);
      const res = await fetchUrl(FEED_URL, 'application/rss+xml, application/xml, text/xml');
      if (res.statusCode === 200) {
        contratos = parseFeedAtom(res.body);
        log(`Feed antiguo devolvió ${contratos.length} contratos`);
      } else {
        log(`Feed antiguo HTTP ${res.statusCode}`);
        // NOTA: Si el RSS del portal antiguo también falla (redirect a /inicio/)
        // se necesitaría PinchTab para navegar el portal SPA.
        // Por ahora documentamos el error y devolvemos vacío.
        log('AVISO: El portal Euskadi requiere PinchTab para extracción completa.');
        log('Configurar y ejecutar: pinchtab nav https://www.contratacion.euskadi.eus/inicio/');
        log('Buscar en "Búsqueda de anuncios" y extraer tabla de resultados.');
      }
    } catch (err) {
      log(`ERROR fallback feed: ${err.message}`);
    }
  }

  log(`Total contratos Euskadi: ${contratos.length}`);

  const output = {
    contratos,
    fuente              : 'EUSKADI',
    ultima_actualizacion: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    if (contratos.length > 0) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2), 'utf8');
      log(`Guardados ${contratos.length} en ${DATA_FILE}`);
    } else {
      log(`Sin contratos nuevos — manteniendo datos anteriores`);
    }
  } catch (err) {
    log(`ERROR al guardar: ${err.message}`);
  }

  return { total: contratos.length, contratos };
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(r => console.log(`Total Euskadi: ${r.total}`))
    .catch(err => console.error('ERROR:', err.message));
}
