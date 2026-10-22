/**
 * Conector Valencia v2 — Open Data GVA (CKAN API)
 *
 * Fuente: https://dadesobertes.gva.es (CKAN API)
 * Total disponible: 8.5M contratos (2000-2026)
 * Método: CKAN package_show → download CSV resources
 *
 * Ref: BquantFinance/licitaciones-espana/scripts/ccaa_valencia.py
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'valencia_contracts.json');
const LOG_FILE  = path.join(__dirname, '..', 'logs', 'valencia_v2.log');

// CKAN dataset IDs for contratación (most recent years)
const DATASETS = [
  'eco-gvo-contratos-2025',
  'eco-gvo-contratos-2024',
  'eco-gvo-contratos-2026', // might not exist yet
];

const CKAN_API = 'https://dadesobertes.gva.es/api/3/action/package_show';

function log(msg) {
  const line = `[${new Date().toISOString()}] [valencia_v2] ${msg}`;
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
      timeout : 120000,
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

// ─── CSV parser ─────────────────────────────────────────────────────

function parseCsvLine(line, sep = ';') {
  const result = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && i + 1 < line.length && line[i + 1] === '"') {
        current += '"'; i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === sep && !inQuote) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ─── Normalizers ────────────────────────────────────────────────────

function normEstado(raw) {
  if (!raw) return 'desconocido';
  const s = raw.toLowerCase();
  if (s.includes('adjudica')) return 'adjudicada';
  if (s.includes('formaliz')) return 'formalizada';
  if (s.includes('resuel')) return 'resuelta';
  if (s.includes('abierta') || s.includes('en plazo')) return 'abierta';
  if (s.includes('evaluaci')) return 'evaluacion';
  if (s.includes('publicad')) return 'publicado';
  if (s.includes('anulad')) return 'anulada';
  return s;
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
  const m = String(raw).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const m2 = String(raw).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return String(raw).substring(0, 10);
}

// ─── Parse CSV ──────────────────────────────────────────────────────

function parseCsv(csvText) {
  const clean = csvText.replace(/^\uFEFF/, '');
  const lines = clean.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Detect separator (could be ; or ,)
  const sep = lines[0].includes(';') ? ';' : ',';
  const headers = parseCsvLine(lines[0], sep).map(h => h.toLowerCase().replace(/[""]/g, '').trim());

  const contratos = [];
  const cutoff = new Date(Date.now() - 30 * 86400000);

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i], sep);
    if (cols.length < 3) continue;

    const get = (key) => {
      const idx = headers.findIndex(h => h.includes(key));
      return idx >= 0 ? (cols[idx] || '').replace(/^"|"$/g, '') : '';
    };

    const expediente = get('expedient') || get('numero') || get('codi') || `row-${i}`;
    const titulo     = get('objeto') || get('objecte') || get('descripci') || '';
    const organismo  = get('organ') || get('entitat') || get('centro') || '';
    const estado     = get('estado') || get('estat') || '';
    const importe    = get('import') || get('pressupost') || get('valor') || '';
    const adjName    = get('adjudicatari') || get('empresa') || '';
    const fecha      = get('fecha') || get('data') || '';
    const tipo       = get('tipus') || get('tipo') || '';
    const cpv        = get('cpv') || '';

    const fechaISO = normFecha(fecha);
    const fechaDate = fechaISO ? new Date(fechaISO) : null;

    if (fechaDate && fechaDate < cutoff) continue;

    contratos.push({
      id              : `VAL:${expediente}`,
      titulo,
      objeto          : titulo,
      organismo,
      cpv             : cpv.replace(/-\d+$/, ''),
      cpvs            : cpv ? [cpv.replace(/-\d+$/, '')] : [],
      importe         : normImporte(importe),
      importe_num     : parseImporte(importe),
      estado          : normEstado(estado),
      fecha_publicacion: fechaISO,
      fecha_fin       : '',
      fuente          : 'Valencia',
      tipo_contrato   : tipo,
      adjudicatario   : adjName,
      url             : 'https://dadesobertes.gva.es',
      _fuente_file    : 'valencia',
      expediente,
    });
  }

  return contratos;
}

// ─── Main ───────────────────────────────────────────────────────────

async function run() {
  log('=== Iniciando Valencia v2 (CKAN Open Data) ===');

  const contratos = [];

  for (const dsId of DATASETS) {
    log(`  Dataset: ${dsId}`);
    try {
      const res = await fetchUrl(`${CKAN_API}?id=${dsId}`);
      if (res.statusCode !== 200) {
        log(`  HTTP ${res.statusCode} — omitiendo ${dsId}`);
        continue;
      }

      const data = JSON.parse(res.body);
      if (!data.success) {
        log(`  CKAN error: ${JSON.stringify(data.error || {})}`);
        continue;
      }

      const resources = data.result.resources || [];
      const csvResources = resources.filter(r =>
        (r.format || '').toUpperCase() === 'CSV' &&
        (r.name || '').toLowerCase().includes('contrat')
      );

      // If no specific contrat CSVs, take all CSVs
      const targets = csvResources.length > 0 ? csvResources : resources.filter(r => (r.format || '').toUpperCase() === 'CSV');

      log(`  ${dsId}: ${targets.length} CSV resources`);

      for (const resource of targets.slice(0, 5)) {
        log(`    Descargando ${resource.name || resource.url}...`);
        try {
          const csvRes = await fetchUrl(resource.url);
          if (csvRes.statusCode !== 200) {
            log(`    HTTP ${csvRes.statusCode}`);
            continue;
          }
          const parsed = parseCsv(csvRes.body);
          log(`    ${parsed.length} contratos recientes`);
          contratos.push(...parsed);
        } catch (err) {
          log(`    ERROR: ${err.message}`);
        }
        await sleep(500);
      }
    } catch (err) {
      log(`  ERROR ${dsId}: ${err.message}`);
    }
    await sleep(1000);
  }

  log(`Total Valencia v2: ${contratos.length} contratos`);

  if (contratos.length === 0) {
    log('Sin contratos — manteniendo datos anteriores');
    return { total: 0, contratos: [] };
  }

  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, contratos, {
    fuente: 'VALENCIA_V2',
    meta: { metodo: 'ckan_csv' },
    log,
  });

  return { total: stats.total };
}

if (require.main === module) {
  run()
    .then(r => console.log(`✓ Valencia v2: ${r.total} contratos`))
    .catch(err => console.error('Error:', err));
}

module.exports = { run };
