/**
 * Conector Asturias v1 — Open Data CSV anual
 *
 * Fuente: https://descargas.asturias.es/asturias/opendata/SectorPublico/contratacion
 * Total disponible: ~375K contratos (2019-2024 en DuckDB)
 * Método: CSV por año, separador §, encoding latin-1, parseo incremental
 *
 * Ref: BquantFinance/scripts/ccaa_asturias.py
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE_URL  = 'https://descargas.asturias.es/asturias/opendata/SectorPublico/contratacion';
const DATA_FILE = path.join(__dirname, '..', 'data', 'asturias_contracts.json');
const LOG_FILE  = path.join(__dirname, '..', 'logs', 'asturias_v1.log');

// Solo años recientes (el merge mantiene contratos viejos por ID)
const YEARS = [new Date().getFullYear(), new Date().getFullYear() - 1];
// Si el año actual no existe (404), intentamos el anterior
const YEARS_FALLBACK = [new Date().getFullYear() - 1, new Date().getFullYear() - 2];

const RATE_MS     = 300;
const MAX_PER_YEAR = 30000; // Cap por año (21K es lo típico para 2024)

function log(msg) {
  const line = `[${new Date().toISOString()}] [asturias_v1] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchCsv(year) {
  const url = `${BASE_URL}/dataset-contratacion-centralizada-${year}.csv`;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
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

    const req = https.request(options, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location || '';
        res.resume();
        return resolve(fetchRedirect(loc));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ statusCode: res.statusCode, body: null });
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        // Asturias CSV is latin-1 encoded
        const body = Buffer.concat(chunks).toString('latin1');
        resolve({ statusCode: 200, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function fetchRedirect(rawUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
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
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── CSV parser (§ separator, latin-1) ───────────────────────────────

function parseCsvLine(line, sep = '\u00A7') {
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
  const s = raw.toLowerCase().trim();
  if (s.includes('adjudica')) return 'adjudicada';
  if (s.includes('formaliz')) return 'formalizada';
  if (s.includes('resuel')) return 'resuelta';
  if (s.includes('abiert') || s.includes('activ')) return 'abierta';
  if (s.includes('evaluaci')) return 'evaluacion';
  if (s.includes('publicad')) return 'publicado';
  if (s.includes('anulad')) return 'anulada';
  if (s.includes('desiert')) return 'desierta';
  if (s.includes('firm') || s.includes('pendiente')) return 'pendiente';
  return s;
}

function parseImporte(val) {
  if (!val) return 0;
  // Spanish format: 6.050,00 → 6050.00
  const cleaned = String(val)
    .replace(/\./g, '')          // remove thousand separators
    .replace(/,/g, '.')          // comma decimal → dot
    .replace(/[^\d.\-]/g, ''); // remove currency symbols
  return parseFloat(cleaned) || 0;
}

function normImporte(val) {
  const n = parseImporte(val);
  if (!n) return '—';
  if (n >= 1e9) return `€ ${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `€ ${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `€ ${Math.round(n / 1e3)}K`;
  return `€ ${Math.round(n)}`;
}

function normFecha(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // DD/MM/YYYY
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2, '0')}-${m1[1].padStart(2, '0')}`;
  // DD-MM-YYYY
  const m2 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  // YYYY-MM-DD (fallback)
  const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m3) return s;
  return s.substring(0, 10);
}

function normTipoContrato(raw) {
  if (!raw) return '';
  const s = raw.toLowerCase().trim();
  if (s.includes('obra')) return 'obras';
  if (s.includes('servicio')) return 'servicios';
  if (s.includes('suministro')) return 'suministros';
  if (s.includes('consultoria')) return 'consultoría';
  if (s.includes('concesion')) return 'concesión';
  return s;
}

// ─── Parse single year CSV ─────────────────────────────────────────

function parseYear(csvText, year) {
  const clean = csvText.replace(/^\uFEFF/, '');
  const lines = clean.split('\n').filter(l => l.trim());
  if (lines.length < 2) {
    log(`  ${year}: CSV vacío o sin datos`);
    return [];
  }

  const sep = '\u00A7'; // § character
  const headers = parseCsvLine(lines[0], sep).map(h => h.toLowerCase().trim().replace(/^"|"$/g, ''));

  // Column mapping: find index by keyword
  const find = (keywords) => {
    for (const kw of keywords) {
      const idx = headers.findIndex(h => h.includes(kw.toLowerCase()));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const idx = {
    inscripcion: find(['inscripcion']),
    expediente:  find(['expediente organo', 'nº expediente']),
    alta:        find(['f. de alta', 'fecha alta']),
    objeto:      find(['objeto']),
    presupuesto: find(['presupuesto']),
    iva:         find(['iva']),
    caracteristicas: find(['caracteristicas contrato']),
    estado:      find(['estado contrato']),
    ente:        find(['ente contratante']),
    organo:      find(['organo contratante']),
    cpv:         find(['codigo cpv']),
    modalidad:   find(['modalidad']),
    adjudicacion: find(['f. adj.', 'fecha adj']),
    formalizacion: find(['f. formalizacion', 'fecha formalizacion']),
    adj_importe: find(['imp. adj. (con iva)', 'importe adj']),
    nif:         find(['nif/cif contratista']),
    razonsocial: find(['razon social contratista']),
    proc_adj:    find(['proc. adjudicacion', 'procedimiento adjudicacion']),
    ofertas:     find(['invitaciones']),
  };

  const contratos = [];
  let skipCount = 0;

  for (let i = 1; i < lines.length && contratos.length < MAX_PER_YEAR; i++) {
    const cols = parseCsvLine(lines[i], sep);
    if (cols.length < 5) continue;

    const get = (key) => {
      const cIdx = idx[key];
      return cIdx >= 0 ? (cols[cIdx] || '').replace(/^"|"$/g, '').trim() : '';
    };

    const expedienteRaw = get('expediente') || get('inscripcion');
    if (!expedienteRaw) { skipCount++; continue; }

    const fechaAlta = normFecha(get('alta'));

    // Build canonical ID
    const id = `AST:${year}:${expedienteRaw}`;

    const presupuesto = get('presupuesto');
    const importeAdj  = get('adj_importe');
    const ivaStr      = get('iva');
    const ivaPct      = parseFloat(ivaStr) || 21; // default 21%

    const importeNum = parseImporte(presupuesto);
    const importeConIva = importeNum ? importeNum * (1 + ivaPct / 100) : 0;
    const importeAdjNum = parseImporte(importeAdj);
    const importeAdjConIva = importeAdjNum ? importeAdjNum * (1 + ivaPct / 100) : 0;

    const cpvRaw = get('cpv');
    const cpvClean = cpvRaw.replace(/-\d+$/, '').trim();

    // Inferir estado real: si tiene fecha de adjudicación/formalización, no está 'abierta'
    // Asturias CSV marca todo como ACTIVO — inferimos el estado real:
    //   - Con fecha formalización → formalizada
    //   - Con fecha adjudicación o importe adjudicado → adjudicada
    //   - Sin adjudicación → publicado (estado del CSV, no 'abierta')
    //     'publicado' está en ACTIVE_ESTADOS del merge, pero se purgará
    //     si fecha_publicacion > MAX_AGE_DEFAULT_DAYS (180 días)
    const estadoRaw = get('estado');
    const fechaAdj = normFecha(get('adjudicacion'));
    const fechaFormaliz = normFecha(get('formalizacion'));
    const adjImporte = parseImporte(get('adj_importe'));
    const adjRazonSocial = get('razonsocial');

    let estado;
    if (fechaFormaliz) {
      estado = 'formalizada';
    } else if (fechaAdj || (adjImporte > 0) || adjRazonSocial) {
      estado = 'adjudicada';
    } else {
      // Sin adjudicación: usar el estado real del CSV (ACTIVO)
      // 'activo' no está en ACTIVE_ESTADOS del merge, así que se purgará
      // a los MAX_AGE_DEFAULT_DAYS (180 días) si no tiene fecha_fin futura
      estado = 'activo';
    }

    contratos.push({
      id              : id,
      expediente      : expedienteRaw,
      objeto          : get('objeto') || '',
      organo_contratante: get('organo') || get('ente') || '',
      nif_organo      : '', // not available in Asturias CSV
      tipo_contrato   : normTipoContrato(get('caracteristicas')),
      procedimiento   : get('proc_adj') || get('modalidad') || '',
      estado          : estado,
      importe_sin_iva : importeNum,
      importe_con_iva : importeConIva,
      importe_adjudicacion: importeAdjNum,
      importe_adj_con_iva : importeAdjConIva,
      adjudicatario   : get('razonsocial') || '',
      nif_adjudicatario: get('nif') || '',
      num_ofertas     : parseInt(get('ofertas')) || 0,
      cpv_principal   : cpvClean,
      cpvs            : cpvClean ? [cpvClean] : [],
      ubicacion       : 'Asturias',
      fecha_publicacion: fechaAlta,
      fecha_adjudicacion: fechaAdj || fechaFormaliz || '',
      fuente          : 'Asturias',
      archivo_origen  : `dataset-contratacion-centralizada-${year}.csv`,
      _fuente_file    : 'asturias',
      // Display fields for Elicita UI
      titulo          : get('objeto') || '',
      organismo       : get('organo') || get('ente') || '',
      importe         : normImporte(presupuesto),
      importe_num     : importeNum,
      url             : '',
    });
  }

  if (skipCount > 0) log(`  ${year}: ${skipCount} filas sin expediente (saltadas)`);
  return contratos;
}

// ─── Status tracking for incremental updates ────────────────────────

const STATUS_FILE = path.join(__dirname, '..', 'data', 'asturias_status.json');

function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
  } catch (_) {}
  return { lastRun: null, yearsProcessed: {}, totalContratos: 0 };
}

function saveStatus(status) {
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), 'utf8');
}

// ─── Main ───────────────────────────────────────────────────────────

async function run() {
  log('=== Iniciando Asturias v1 (CSV Open Data) ===');

  const status = loadStatus();
  const allContratos = [];
  const now = new Date().toISOString();

  const currentYear = new Date().getFullYear();
  const yearsToFetch = [currentYear, currentYear - 1];
  log(`Años a descargar: ${yearsToFetch.join(', ')}`);

  let all404 = true;
  for (const year of yearsToFetch) {
    log(`  Año ${year}...`);
    try {
      const res = await fetchCsv(year);
      if (res.statusCode === 404) {
        log(`  ${year}: 404 (aún no publicado)`);
        continue;
      }
      if (res.statusCode !== 200) {
        log(`  ${year}: HTTP ${res.statusCode}`);
        continue;
      }
      all404 = false;

      const parsed = parseYear(res.body, year);
      log(`  ${year}: ${parsed.length} contratos`);
      allContratos.push(...parsed);

      status.yearsProcessed[year] = {
        lastFetch: now,
        contratos: parsed.length,
        bytes: res.body.length,
      };
    } catch (err) {
      log(`  ${year}: ERROR ${err.message}`);
    }
    await sleep(RATE_MS);
  }

  // Fallback: if current year is 404, try previous years
  if (all404) {
    log(`  Todos los años actuales son 404 — intentando ${currentYear - 1} y ${currentYear - 2}`);
    for (const year of [currentYear - 1, currentYear - 2]) {
      if (yearsToFetch.includes(year)) continue; // Already tried
      log(`  Año ${year} (fallback)...`);
      try {
        const res = await fetchCsv(year);
        if (res.statusCode === 404) {
          log(`  ${year}: 404 (tampoco disponible)`);
          continue;
        }
        if (res.statusCode !== 200) {
          log(`  ${year}: HTTP ${res.statusCode}`);
          continue;
        }

        const parsed = parseYear(res.body, year);
        log(`  ${year}: ${parsed.length} contratos`);
        allContratos.push(...parsed);
      } catch (err) {
        log(`  ${year}: ERROR ${err.message}`);
      }
      await sleep(RATE_MS);
    }
  }

  status.lastRun = now;
  status.totalContratos = allContratos.length;
  saveStatus(status);

  log(`Total Asturias v1: ${allContratos.length} contratos`);

  if (allContratos.length === 0) {
    log('Sin contratos — manteniendo datos anteriores');
    return { total: 0, contratos: [] };
  }

  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, allContratos, {
    fuente: 'ASTURIAS_V1',
    meta: { metodo: 'csv_opendata_anual' },
    log,
  });

  return { total: stats.total };
}

if (require.main === module) {
  run()
    .then(r => console.log(`✓ Asturias v1: ${r.total} contratos`))
    .catch(err => console.error('Error:', err));
}

module.exports = { run };
