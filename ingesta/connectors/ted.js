/**
 * Conector TED — Tenders Electronic Daily (EU)
 * API v3: https://api.ted.europa.eu/v3/notices/search
 * Sin API key para consultas públicas (rate limit generoso)
 *
 * Cubre: contratos >€215K que los organismos españoles publican obligatoriamente en TED
 * Especialmente relevante para: ADIF, Ministerio Transportes, Puertos del Estado
 */

const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const fs = require('fs');
const path = require('path');

const TED_API = 'https://api.ted.europa.eu/v3/notices/search';
const DATA_FILE = path.join(__dirname, '..', 'data', 'ted_contracts.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'ted.log');

// Sin filtro CPV — capturamos TODOS los contratos españoles en TED

const FIELDS = [
  'notice-identifier',
  'title-lot',
  'description-lot',
  'organisation-name-buyer',
  'organisation-city-buyer',
  'classification-cpv',
  'estimated-value-lot',
  'deadline-date-lot',
  'publication-date',
  'notice-type',
  'publication-number',
  'links',
];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Extrae texto del formato TED que puede ser: string, objeto {#text, @language}, o array de objetos
function extractText(val, langPriority = ['spa', 'eng']) {
  if (!val) return '';
  
  // Si es string directo
  if (typeof val === 'string') return val;
  
  // Si es array (varios idiomas)
  if (Array.isArray(val)) {
    for (const lang of langPriority) {
      const found = val.find(item => {
        const itemLang = item?.['@language']?.toLowerCase() || item?.['@xml:lang']?.toLowerCase();
        return itemLang === lang || itemLang?.startsWith(lang);
      });
      if (found) return extractText(found);
    }
    // Si no hay coincidencia de idioma, tomar el primero
    return extractText(val[0]);
  }
  
  // Si es objeto con #text
  if (typeof val === 'object') {
    if (val['#text']) return val['#text'];
    // Si es objeto con claves de idioma como {spa: [...]}
    for (const lang of langPriority) {
      if (val[lang]) {
        const langVal = val[lang];
        if (Array.isArray(langVal)) return extractText(langVal[0]);
        return String(langVal);
      }
    }
    return JSON.stringify(val);
  }
  
  return String(val);
}

function normalizeEntry(n) {
  try {
    const pubNum = n['publication-number'] || n['notice-identifier'] || '';
    
    // Extraer título (prioridad: español, inglés)
    const titulo = extractText(n['title-lot']);

    // Extraer organismo
    const organismo = extractText(n['organisation-name-buyer']);

    const importes = n['estimated-value-lot'] || [];
    const importe = Array.isArray(importes)
      ? parseFloat(importes[0]) || 0
      : parseFloat(importes) || 0;

    const cpvs = n['classification-cpv'] || [];
    const deadlines = n['deadline-date-lot'] || [];
    const deadline = Array.isArray(deadlines) ? deadlines[0] : deadlines;

    const url = n['links']?.html?.SPA || n['links']?.html?.ENG
      || `https://ted.europa.eu/es/notice/-/detail/${pubNum}`;

    return {
      id: `TED:${pubNum}`,
      fuente: 'TED',
      expediente: pubNum,
      titulo: titulo,
      organismo: organismo || 'Organismo no especificado',
      cpvs: Array.isArray(cpvs) ? [...new Set(cpvs)] : [cpvs],
      importe_licitacion: importe,
      fecha_publicacion: n['publication-date'] || new Date().toISOString(),
      fecha_fin_presentacion: deadline || null,
      notice_type: n['notice-type'] || '',
      estado: mapEstadoTED(n['notice-type']),
      url_fuente: url,
    };
  } catch (err) {
    return null;
  }
}

// Mapear notice-type de TED a estado legible
function mapEstadoTED(noticeType) {
  if (!noticeType) return 'abierta';
  const t = noticeType.toLowerCase();
  // cn- = Contract Notice (licitación)
  if (t.startsWith('cn-')) return 'abierta';
  // can- = Contract Award Notice (adjudicación/resultado)
  if (t.startsWith('can-')) return 'adjudicada';
  // pin- = Prior Information Notice (anuncio previo)
  if (t.startsWith('pin-')) return 'anuncio_previo';
  // veat = Voluntary Ex Ante Transparency
  if (t.startsWith('veat')) return 'adjudicada';
  return 'abierta';
}

async function fetchPage(page = 1) {
  try {
    // Últimos 90 días, todos los contratos españoles, sin filtro CPV
    const body = {
      query: 'organisation-country-buyer=ESP',
      fields: FIELDS,
      limit: 100,
      page,
      scope: 'ACTIVE',
    };

    const res = await fetch(TED_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text();
      log(`  ✗ TED página ${page}: HTTP ${res.status} — ${txt.slice(0, 100)}`);
      return { notices: [], total: 0 };
    }

    const data = await res.json();
    const notices = (data.notices || []).map(normalizeEntry).filter(Boolean);
    return { notices, total: data.totalNoticeCount || 0 };

  } catch (err) {
    log(`  ✗ TED página ${page}: ${err.message}`);
    return { notices: [], total: 0 };
  }
}

async function run() {
  log('=== Inicio ingesta TED (todos los contratos ESP) ===');

  const todos = [];
  const vistos = new Set();
  let page = 1;
  let totalAvailable = 0;
  const MAX_PAGES = 20; // Safety: 20 × 100 = 2000 notices max por ciclo

  while (page <= MAX_PAGES) {
    log(`  → TED página ${page}...`);
    const { notices, total } = await fetchPage(page);
    if (page === 1) {
      totalAvailable = total;
      log(`  Total disponible en TED: ${totalAvailable}`);
    }

    if (notices.length === 0) break;

    for (const c of notices) {
      if (!vistos.has(c.id)) {
        vistos.add(c.id);
        todos.push(c);
      }
    }

    log(`  ✓ Página ${page}: ${notices.length} notices (acumulado: ${todos.length})`);

    if (todos.length >= totalAvailable || notices.length < 100) break;
    page++;
    await sleep(1000);
  }

  log(`Total contratos TED únicos: ${todos.length}`);

  // Merge-by-ID: acumula contratos, no sobreescribe
  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, todos, { fuente: 'TED', log });

  log(`✅ Guardado en ${DATA_FILE}`);
  log('=== Fin ingesta TED ===\n');

  return { total: stats.total };
}

module.exports = { run, normalizeEntry, mapEstadoTED };

if (require.main === module) {
  run().catch(err => {
    log(`ERROR FATAL: ${err.message}`);
    process.exit(1);
  });
}
