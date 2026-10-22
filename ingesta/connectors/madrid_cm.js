/**
 * Conector Madrid CM — Comunidad de Madrid (contratos-publicos.comunidad.madrid)
 *
 * Fuente: Portal de Contratación Pública de la Comunidad de Madrid
 * Total disponible: 2.56M contratos (2017-2026), 50K+/mes en ventana de 30 días
 * Método: HTTP con antibot_key (Drupal) + CAPTCHA matemático + CSV export
 *
 * Flujo:
 *   0. GET /contratos → extraer antibot_key de drupal-settings JSON (invertir en pares de 2)
 *   1. GET /contratos?antibot_key=XXX&filtros → registra filtros en sesión
 *   2. GET /buscador-contratos/csv → formulario CAPTCHA matemático ("3 + 8 =")
 *   3. POST CAPTCHA → formulario completion
 *   4. POST completion → CSV
 *
 * Ref: BquantFinance/licitaciones-espana/comunidad_madrid/descarga_contratacion_comunidad_madrid_v1.py
 */

'use strict';

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const cheerio = require('cheerio');

const BASE_URL   = 'https://contratos-publicos.comunidad.madrid';
const SEARCH_URL = `${BASE_URL}/contratos`;
const CSV_URL    = `${BASE_URL}/buscador-contratos/csv`;
const DATA_FILE  = path.join(__dirname, '..', 'data', 'madrid_cm_contracts.json');
const LOG_FILE   = path.join(__dirname, '..', 'logs', 'madrid_cm.log');

const DAYS_BACK  = 30;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function log(msg) {
  const line = `[${new Date().toISOString()}] [madrid_cm] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP helpers with cookie jar ───────────────────────────────────

class CookieJar {
  constructor() { this.cookies = {}; }
  parse(headers) {
    const raw = headers['set-cookie'] || [];
    const arr = Array.isArray(raw) ? raw : [raw];
    for (const c of arr) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (m) this.cookies[m[1]] = m[2];
    }
  }
  toString() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

const jar = new CookieJar();

function httpReq(rawUrl, { method = 'GET', body = null, followRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const options = {
      hostname: url.hostname,
      path    : url.pathname + url.search,
      method,
      timeout : 120000,
      headers : {
        'User-Agent'  : UA,
        'Accept'      : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie'      : jar.toString(),
      },
    };

    if (body) {
      const payload = typeof body === 'string' ? body
        : Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
      var bodyStr = payload;
    }

    const req = https.request(options, res => {
      jar.parse(res.headers);

      if ((res.statusCode === 301 || res.statusCode === 302) && followRedirects > 0) {
        let loc = res.headers.location || '';
        if (loc.startsWith('/')) loc = `${url.protocol}//${url.hostname}${loc}`;
        res.resume();
        return resolve(httpReq(loc, { method: 'GET', followRedirects: followRedirects - 1 }));
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers   : res.headers,
          body      : buf.toString('utf-8'),
          buffer    : buf,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Antibot key ────────────────────────────────────────────────────

function transformAntibotKey(raw) {
  let result = '';
  for (let i = raw.length - 1; i >= 0; i -= 2) {
    if (i - 1 >= 0) result += raw[i - 1] + raw[i];
    else result += raw[i];
  }
  return result;
}

async function getAntibotKey() {
  const res = await httpReq(SEARCH_URL);
  if (res.statusCode !== 200) throw new Error(`Search page HTTP ${res.statusCode}`);

  const m = res.body.match(/data-drupal-selector="drupal-settings-json"[^>]*>(.*?)<\/script>/s);
  if (!m) throw new Error('No drupal-settings-json found');

  const settings = JSON.parse(m[1]);
  const forms = (settings.antibot || {}).forms || {};
  for (const v of Object.values(forms)) {
    if (v.key) return transformAntibotKey(v.key);
  }
  throw new Error('No antibot key found in settings');
}

// ─── CAPTCHA solver ─────────────────────────────────────────────────

function solveCaptcha(text) {
  const m = text.match(/(\d+)\s*([+\-*/])\s*(\d+)\s*=/);
  if (!m) return null;
  const a = parseInt(m[1]), op = m[2], b = parseInt(m[3]);
  const ops = { '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => Math.floor(x / y) };
  return (ops[op] || (() => null))(a, b);
}

// ─── CSV parser ─────────────────────────────────────────────────────

function parseCsvLine(line) {
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
    } else if (ch === ';' && !inQuote) {
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
  if (s.includes('en plazo') || s.includes('abierta')) return 'abierta';
  if (s.includes('evaluaci') || s.includes('valoraci')) return 'evaluacion';
  if (s.includes('adjudica')) return 'adjudicada';
  if (s.includes('formaliz')) return 'formalizada';
  if (s.includes('resuel') || s.includes('resoluc')) return 'resuelta';
  if (s.includes('desierto')) return 'desierta';
  if (s.includes('anulad')) return 'anulada';
  if (s.includes('publicad')) return 'publicado';
  return s;
}

function normImporte(val) {
  const n = parseFloat((val || '').replace(/[^\d.,\-]/g, '').replace(',', '.')) || 0;
  if (!n) return '—';
  if (n >= 1e9) return `€ ${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `€ ${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `€ ${Math.round(n / 1e3)}K`;
  return `€ ${Math.round(n)}`;
}

function parseImporte(val) {
  return parseFloat((val || '').replace(/[^\d.,\-]/g, '').replace(',', '.')) || 0;
}

function normFecha(raw) {
  if (!raw) return '';
  const clean = raw.trim();
  // Format: "01-03-2026" or "01/03/2026"
  const m = clean.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // Format: "12 de junio de 2026" or "12 de juni de 2026" (month abbreviations)
  const months = {
    'enero': '01', 'feb': '02', 'febrero': '02', 'marzo': '03', 'abr': '04', 'abril': '04',
    'mayo': '05', 'junio': '06', 'juni': '06', 'julio': '07', 'agosto': '08',
    'septiembre': '09', 'sep': '09', 'octubre': '10', 'noviembre': '11', 'diciembre': '12'
  };
  const words = clean.toLowerCase().replace(/,/g, '').split(/\s+/);
  if (words.length >= 4 && words[1] === 'de' && words[3] === 'de') {
    const day = words[0].padStart(2, '0');
    const month = months[words[2]] || '';
    const year = words[4];
    if (day && month && year && year.match(/^\d{4}$/)) {
      return `${year}-${month}-${day}`;
    }
  }
  // Fallback: if we have a default date from the search window, use it
  if (raw && raw.match(/^\d{2}-\d{2}-\d{4}$/)) {
    const m = raw.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  }
  return '';  // Empty means it will be rejected by schema unless we use defaultFecha
}

// ─── Main flow ──────────────────────────────────────────────────────

async function downloadCsv(antibotKey, fechaDesde, fechaHasta) {
  // Step 1: Search
  const searchParams = new URLSearchParams({
    antibot_key      : antibotKey,
    createddate      : fechaDesde,
    createddate_1    : fechaHasta,
    tipo_publicacion : 'All',
    entidad_adjudicadora: 'All',
  });
  const searchUrl = `${SEARCH_URL}?${searchParams.toString()}`;
  const r1 = await httpReq(searchUrl);
  if (r1.statusCode !== 200) throw new Error(`Search HTTP ${r1.statusCode}`);
  log('  Búsqueda registrada en sesión');

  await sleep(2000);

  // Step 2: Get CAPTCHA form
  const r2 = await httpReq(CSV_URL);
  const $ = cheerio.load(r2.body);
  const form = $('form[action*="csv"]').first();
  if (!form.length) throw new Error('No CSV form found');

  const captchaText = form.text();
  const answer = solveCaptcha(captchaText);
  if (answer === null) throw new Error('CAPTCHA not solvable');
  log(`  CAPTCHA resuelto: ${answer}`);

  // Collect form fields
  const formData = {};
  form.find('input').each((_, el) => {
    const name = $(el).attr('name');
    if (name) formData[name] = $(el).attr('value') || '';
  });
  formData['captcha_response'] = String(answer);

  let action = form.attr('action') || '/buscador-contratos/csv';
  if (action.startsWith('/')) action = BASE_URL + action;

  await sleep(1000);

  // Step 3: POST CAPTCHA
  const r3 = await httpReq(action, { method: 'POST', body: formData });
  const ct3 = r3.headers['content-type'] || '';
  const cd3 = r3.headers['content-disposition'] || '';

  if (ct3.includes('csv') || ct3.includes('octet') || cd3) {
    return r3.body;
  }

  // Step 4: Completion form
  const $4 = cheerio.load(r3.body);
  const form2 = $4('form[id*="completion"]').first().length
    ? $4('form[id*="completion"]').first()
    : $4('form[action*="completion"]').first();

  if (!form2.length) throw new Error('No completion form found');

  const formData2 = {};
  form2.find('input').each((_, el) => {
    const name = $4(el).attr('name');
    if (name) formData2[name] = $4(el).attr('value') || '';
  });

  let action2 = form2.attr('action') || '';
  if (action2.startsWith('/')) action2 = BASE_URL + action2;

  const r4 = await httpReq(action2, { method: 'POST', body: formData2 });
  const ct4 = r4.headers['content-type'] || '';
  const cd4 = r4.headers['content-disposition'] || '';

  if (ct4.includes('csv') || ct4.includes('octet') || cd4) {
    return r4.body;
  }

  throw new Error(`Completion did not return CSV (CT: ${ct4})`);
}

function csvToContratos(csvText, defaultFecha = '') {
  // Remove BOM
  const clean = csvText.replace(/^\uFEFF/, '');
  const lines = clean.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  // Debug: log actual CSV headers to detect column name changes
  log(`CSV headers (${headers.length}): ${headers.map(h => h.replace(/["']/g, '')).join(' | ')}`);
  // Expected: Tipo de Publicación;Estado;Entidad Adjudicadora;Nº Expediente;Referencia;
  //           Título del contrato;Tipo de contrato;Procedimiento de adjudicación;
  //           Presupuesto de licitación;Nº de ofertas;Resultado;NIF del adjudicatario;
  //           Adjudicatario;Fecha del contrato;Importe de adjudicación;
  //           Importe de las modificaciones;Importe de las prórrogas;Importe de la liquidación

  const idxMap = {};
  headers.forEach((h, i) => { idxMap[h.toLowerCase().replace(/[\u0022\u0027]/g, '')] = i; });
  log('idxMap keys: ' + Object.keys(idxMap).join(', '));

  const contratos = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 6) continue;

    const get = (key) => {
      const idx = idxMap[key];
      return idx !== undefined ? (cols[idx] || '').replace(/^"|"$/g, '') : '';
    };

    const expediente = get('nº expediente') || get('n\u00ba expediente') || `row-${i}`;
    const titulo     = get('título del contrato') || get('titulo del contrato') || '';
    const organismo  = get('entidad adjudicadora') || '';
    const estado     = get('estado') || '';
    const presupuesto = get('presupuesto de licitación') || get('presupuesto de licitacion') || '';
    const importeAdj  = get('importe de adjudicación') || get('importe de adjudicacion') || '';
    const adjName    = get('adjudicatario') || '';
    const adjNif     = get('nif del adjudicatario') || '';
    const fechaRaw   = get('fecha del contrato') || get('fecha de publicación') || get('fecha de publicacion');
    let fecha        = fechaRaw ? normFecha(fechaRaw) : '';
    // If normFecha couldn't parse, use search window start as fallback
    if (!fecha) fecha = normFecha(defaultFecha) || '';
    if (i <= 3 && i > 0) log(`Row ${i}: raw='${fechaRaw}' parsed='${fecha}' default='${defaultFecha}'`);
    const tipo       = get('tipo de contrato') || '';

    contratos.push({
      id              : `MCM:${expediente}`,
      titulo,
      objeto          : titulo,
      organismo,
      cpv             : '',   // Not in CSV export
      cpvs            : [],
      importe         : normImporte(presupuesto),
      importe_num     : parseImporte(presupuesto),
      importe_adjudicacion: parseImporte(importeAdj),
      estado          : normEstado(estado),
      fecha_publicacion: fecha,
      fecha_fin       : '',
      fuente          : 'Madrid CM',
      tipo_contrato   : tipo,
      adjudicatario   : adjName,
      nif_adjudicatario: adjNif,
      url             : `https://contratos-publicos.comunidad.madrid/contratos?numero_expediente=${encodeURIComponent(expediente)}`,
      _fuente_file    : 'madrid_cm',
      expediente,
    });
  }

  return contratos;
}

async function run() {
  log('=== Iniciando Madrid CM (antibot + CAPTCHA + CSV) ===');

  const now = new Date();
  const cutoff = new Date(Date.now() - DAYS_BACK * 86400000);
  const fechaDesde = `${String(cutoff.getDate()).padStart(2, '0')}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${cutoff.getFullYear()}`;
  const fechaHasta = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;

  log(`Ventana: ${fechaDesde} → ${fechaHasta}`);

  let attempts = 0;
  let csvText = null;

  while (attempts < 3 && !csvText) {
    try {
      // Reset cookies for each attempt
      jar.cookies = {};

      log(`  Obteniendo antibot key (intento ${attempts + 1})...`);
      const antibotKey = await getAntibotKey();
      log(`  Antibot OK: ${antibotKey.substring(0, 20)}...`);

      csvText = await downloadCsv(antibotKey, fechaDesde, fechaHasta);
    } catch (err) {
      log(`  ERROR intento ${attempts + 1}: ${err.message}`);
      attempts++;
      await sleep(5000 * attempts);
    }
  }

  if (!csvText) {
    log('No se pudo obtener CSV — manteniendo datos anteriores');
    return { total: 0, contratos: [] };
  }

  const contratos = csvToContratos(csvText, fechaDesde);
  log(`Total Madrid CM: ${contratos.length} contratos (${DAYS_BACK} días)`);

  if (contratos.length === 0) {
    log('Sin contratos — manteniendo datos anteriores');
    return { total: 0, contratos: [] };
  }

  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, contratos, {
    fuente: 'MADRID_CM',
    meta: { metodo: 'antibot_captcha_csv' },
    log,
  });

  return { total: stats.total };
}

if (require.main === module) {
  run()
    .then(r => console.log(`✓ Madrid CM: ${r.total} contratos`))
    .catch(err => console.error('Error:', err));
}

module.exports = { run };
