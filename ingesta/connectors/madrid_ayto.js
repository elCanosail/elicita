/**
 * Conector Madrid Ayuntamiento — datos.madrid.es CSV directo
 *
 * Fuente: https://datos.madrid.es (Open Data del Ayuntamiento de Madrid)
 * Total disponible: 119K contratos (2015-2026)
 * Método: Descarga CSVs directos (contratos formalizados + menores del año actual)
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'madrid_ayto_contracts.json');
const LOG_FILE  = path.join(__dirname, '..', 'logs', 'madrid_ayto.log');

// CSVs for current + recent years (formalizados = main contracts, menores = minor)
const CSV_SOURCES = [
  { label: 'Formalizados 2026', url: 'https://datos.madrid.es/egob/catalogo/216876-107-contratos-actividad.csv' },
  { label: 'Formalizados 2025', url: 'https://datos.madrid.es/egob/catalogo/216876-104-contratos-actividad.csv' },
  { label: 'Acuerdo Marco 2025', url: 'https://datos.madrid.es/egob/catalogo/216876-106-contratos-actividad.csv' },
  { label: 'Menores 2026', url: 'https://datos.madrid.es/egob/catalogo/300253-23-contratos-actividad-menores.csv' },
  { label: 'Menores 2025', url: 'https://datos.madrid.es/egob/catalogo/300253-22-contratos-actividad-menores.csv' },
  { label: 'Formalizados 2024', url: 'https://datos.madrid.es/egob/catalogo/216876-22-contratos-actividad.csv' },
];

function log(msg) {
  const line = `[${new Date().toISOString()}] [madrid_ayto] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchUrl(rawUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path    : parsed.pathname + parsed.search,
      method  : 'GET',
      timeout : 60000,
      headers : {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept'    : '*/*',
      },
    };

    const req = lib.request(options, res => {
      if ((res.statusCode === 301 || res.statusCode === 302) && maxRedirects > 0) {
        let loc = res.headers.location || '';
        if (loc.startsWith('/')) loc = `${parsed.protocol}//${parsed.hostname}${loc}`;
        res.resume();
        return resolve(fetchUrl(loc, maxRedirects - 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── CSV parser (semicolon-separated, quoted, multiline-safe) ────────

function parseCsvRows(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const rows = [];
  let current = '';
  let inQuote = false;
  let cols = [];

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];

    if (ch === '"') {
      if (inQuote && next === '"') {
        current += '"'; i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === ';' && !inQuote) {
      cols.push(current.trim());
      current = '';
    } else if ((ch === '\r' || ch === '\n') && !inQuote) {
      if (current !== '' || cols.length > 0) {
        cols.push(current.trim());
        rows.push(cols);
        cols = [];
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current !== '' || cols.length > 0) {
    cols.push(current.trim());
    rows.push(cols);
  }

  return rows;
}

// ─── Normalizers ────────────────────────────────────────────────────

function normEstado(tipo) {
  if (!tipo) return 'desconocido';
  const s = tipo.toLowerCase();
  if (s.includes('menor')) return 'adjudicada';
  if (s.includes('formaliz') || s.includes('inscri')) return 'formalizada';
  if (s.includes('acuerdo') || s.includes('marco')) return 'formalizada';
  if (s.includes('modific')) return 'modificada';
  return 'formalizada';
}

function normImporte(val) {
  const n = parseFloat(String(val || '').replace(/[^\d.,\-]/g, '').replace(',', '.')) || 0;
  if (!n) return '—';
  if (n >= 1e9) return `€ ${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `€ ${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `€ ${Math.round(n / 1e3)}K`;
  return `€ ${Math.round(n)}`;
}

function parseImporte(val) {
  return parseFloat(String(val || '').replace(/[^\d.,\-]/g, '').replace(',', '.')) || 0;
}

function normFecha(raw) {
  if (!raw) return '';
  const m = String(raw).match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[2]}-${m[1]}`;
  }
  if (String(raw).match(/^\d{4}-\d{2}-\d{2}$/)) return raw;
  return String(raw).substring(0, 10);
}

// ─── Parse CSV into contracts ───────────────────────────────────────

function parseCsv(csvText, sourceLabel) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => h.toLowerCase().replace(/"/g, '').trim());

  const contratos = [];

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    if (cols.length < 4) continue;

    const get = (...keys) => {
      for (const key of keys) {
        const idx = headers.findIndex(h => h.includes(key));
        if (idx >= 0) return (cols[idx] || '').replace(/^"|"$/g, '').trim();
      }
      return '';
    };

    const expediente = get('n. de expediente', 'expediente', 'registro') || `row-${i}`;
    const titulo     = get('objeto del contrato', 'objeto') || '';
    const organismo  = get('centro - seccion', 'centro', 'organo de contratacion', 'organo') || '';
    const importe    = get('importe de adjudicacion', 'importe adjudicacion', 'importe total') || '';
    const adjName    = get('razon social adjudicatario', 'adjudicatario', 'razon social') || '';
    const adjNif     = get('nif adjudicatario', 'cif', 'nif') || '';
    const fecha      = get('fecha de inscripcion', 'fecha') || '';
    const tipo       = get('tipo de contrato', 'tipo') || '';

    const fechaISO = normFecha(fecha);

    if (!expediente || expediente === `row-${i}` && !titulo) continue;

    contratos.push({
      id              : `MAY:${expediente}`,
      titulo,
      objeto          : titulo,
      organismo,
      cpv             : '',
      cpvs            : [],
      importe         : normImporte(importe),
      importe_num     : parseImporte(importe),
      estado          : normEstado(sourceLabel),
      fecha_publicacion: fechaISO,
      fecha_fin       : '',
      fuente          : 'Madrid Ayto',
      tipo_contrato   : tipo,
      adjudicatario   : adjName,
      nif_adjudicatario: adjNif,
      url             : 'https://datos.madrid.es',
      _fuente_file    : 'madrid_ayto',
      expediente,
    });
  }

  return contratos;
}

// ─── Main ───────────────────────────────────────────────────────────

async function run() {
  log('=== Iniciando Madrid Ayuntamiento (CSVs Open Data) ===');

  const contratos = [];

  for (const src of CSV_SOURCES) {
    log(`  Descargando ${src.label}...`);
    try {
      const res = await fetchUrl(src.url);
      if (res.statusCode !== 200) {
        log(`  HTTP ${res.statusCode} — omitiendo ${src.label}`);
        continue;
      }
      const parsed = parseCsv(res.body, src.label);
      log(`  ${src.label}: ${parsed.length} contratos`);
      contratos.push(...parsed);
    } catch (err) {
      log(`  ERROR ${src.label}: ${err.message}`);
    }
    await sleep(1000);
  }

  log(`Total Madrid Ayuntamiento: ${contratos.length} contratos`);

  if (contratos.length === 0) {
    log('Sin contratos — manteniendo datos anteriores');
    return { total: 0, contratos: [] };
  }

  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, contratos, {
    fuente: 'MADRID_AYTO',
    meta: { metodo: 'csv_opendata' },
    log,
  });

  return { total: stats.total };
}

if (require.main === module) {
  run()
    .then(r => console.log(`✓ Madrid Ayto: ${r.total} contratos`))
    .catch(err => console.error('Error:', err));
}

module.exports = { run };
