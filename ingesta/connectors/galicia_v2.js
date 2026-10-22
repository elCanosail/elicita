/**
 * Conector Galicia v2.1 — API REST contratosdegalicia.gal
 *
 * Fuente: https://www.contratosdegalicia.gal/api/v1/organismos/{id}/licitaciones/table
 * Total disponible: 1.7M contratos (2000-2026)
 * Método: DataTables JSON paginado por organismo. Paralelismo 5 orgs simultáneos.
 * Fecha formato: DD-MM-YYYY (galicia usa guiones, no slashes)
 *
 * Mejoras v2.1 (vs BquantFinance ref):
 *   - CM ahora captura: adjudicatario, duracion, organismo
 *   - LIC ahora captura: fecha_modificado, _tipo=LIC/CM
 *   - Probe CM en discovery: detecta orgs con CM aunque no tengan LIC
 *   - Top 50 orgs para CM (antes 30) para mayor cobertura de menores
 *   - Better error logging con org IDs
 *
 * Ref: BquantFinance/licitaciones-espana/galicia/scraper_galicia.py
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE_URL  = 'https://www.contratosdegalicia.gal';
const DATA_FILE = path.join(__dirname, '..', 'data', 'galicia_contracts.json');
const LOG_FILE  = path.join(__dirname, '..', 'logs', 'galicia_v2.log');

const PAGE_SIZE     = 100;
const MAX_ORG_ID    = 200;
const CONCURRENCY   = 5;   // parallel org requests
// Ventana de ingesta. Override puntual: GALICIA_DAYS_BACK=400 node connectors/galicia_v2.js
const DAYS_BACK     = parseInt(process.env.GALICIA_DAYS_BACK || '30', 10);

function log(msg) {
  const line = `[${new Date().toISOString()}] [galicia_v2] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP with shared cookie jar ────────────────────────────────────

const jar = {};

function httpGet(rawUrl, referer) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const cookieStr = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const options = {
      hostname: url.hostname,
      path    : url.pathname + url.search,
      timeout : 12000,
      headers : {
        'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept'          : 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer'         : referer || `${BASE_URL}/resultadoIndex.jsp?lang=es`,
        'Cookie'          : cookieStr,
      },
    };

    const req = https.request(options, res => {
      // Collect cookies
      const sc = res.headers['set-cookie'] || [];
      (Array.isArray(sc) ? sc : [sc]).forEach(c => {
        const m = c.match(/^([^=]+)=([^;]*)/);
        if (m) jar[m[1]] = m[2];
      });
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── DataTables params ───────────────────────────────────────────────

function buildParams(start, draw, length = PAGE_SIZE) {
  const COLS = [
    { data: 'id',         name: 'id',        orderable: 'true' },
    { data: 'publicado',  name: 'publicado', orderable: 'true' },
    { data: 'objeto',     name: 'objeto',    orderable: 'true' },
    { data: 'importe',    name: 'importe',   orderable: 'true' },
    { data: 'estadoDesc', name: 'estado',    orderable: 'true' },
    { data: 'modificado', name: 'modificado',orderable: 'true' },
  ];

  const p = new URLSearchParams({
    draw: String(draw), start: String(start), length: String(length),
    'search[value]': '', 'search[regex]': 'false',
    'order[0][column]': '1', 'order[0][dir]': 'desc',
    idioma: 'es', total: '', estados: '',
    _: String(Date.now()),
  });

  COLS.forEach((c, i) => {
    p.set(`columns[${i}][data]`, c.data);
    p.set(`columns[${i}][name]`, c.name);
    p.set(`columns[${i}][searchable]`, 'true');
    p.set(`columns[${i}][orderable]`, c.orderable);
    p.set(`columns[${i}][search][value]`, '');
    p.set(`columns[${i}][search][regex]`, 'false');
  });

  return p.toString();
}

// ─── Normalizers ────────────────────────────────────────────────────

function normEstado(raw) {
  if (!raw) return 'desconocido';
  const s = raw.toLowerCase();
  if (s.includes('adjudica')) return 'adjudicada';
  if (s.includes('formaliz')) return 'formalizada';
  if (s.includes('resuel')) return 'resuelta';
  if (s.includes('abierta') || s.includes('aberto') || s.includes('en plazo')) return 'abierta';
  if (s.includes('evaluaci')) return 'evaluacion';
  if (s.includes('publicad')) return 'publicado';
  if (s.includes('anulad')) return 'anulada';
  if (s.includes('desierto') || s.includes('deserto')) return 'desierta';
  return s;
}

function normImporte(val) {
  const n = parseFloat(val || 0) || 0;
  if (!n) return '—';
  if (n >= 1e9) return `€ ${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `€ ${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `€ ${Math.round(n / 1e3)}K`;
  return `€ ${Math.round(n)}`;
}

function normFecha(raw) {
  if (!raw) return '';
  const m = String(raw).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const m2 = String(raw).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;
  const m3 = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m3) return raw;
  return String(raw).substring(0, 10);
}

// ─── Probe org totals ────────────────────────────────────────────────

async function probeOrg(orgId) {
  const referer = `${BASE_URL}/consultaOrganismo.jsp?OR=${orgId}&N=${orgId}&lang=es`;
  const url = `${BASE_URL}/api/v1/organismos/${orgId}/licitaciones/table?${buildParams(0, 1, 1)}`;
  try {
    const res = await httpGet(url, referer);
    if (res.statusCode !== 200) return 0;
    return JSON.parse(res.body).recordsTotal || 0;
  } catch { return 0; }
}

async function probeOrgCM(orgId) {
  const referer = `${BASE_URL}/consultaOrganismo.jsp?OR=${orgId}&N=${orgId}&lang=es`;
  const dEnd = new Date().toISOString().substring(0, 10);
  const dStart = new Date(Date.now() - 90 * 86400000).toISOString().substring(0, 10);
  const COLS_CM = [
    { data: 'id', name: 'id', orderable: 'true' },
    { data: 'publicado', name: 'publicado', orderable: 'true' },
    { data: 'objeto', name: 'objeto', orderable: 'true' },
    { data: 'importe', name: 'importe', orderable: 'true' },
    { data: 'nif', name: 'nif', orderable: 'true' },
  ];
  const p = new URLSearchParams({
    draw: '1', start: '0', length: '1',
    'search[value]': '', 'search[regex]': 'false',
    'order[0][column]': '1', 'order[0][dir]': 'desc',
    datestart: dStart, dateend: dEnd,
    _: String(Date.now()),
  });
  COLS_CM.forEach((c, i) => {
    p.set(`columns[${i}][data]`, c.data);
    p.set(`columns[${i}][name]`, c.name);
    p.set(`columns[${i}][searchable]`, 'true');
    p.set(`columns[${i}][orderable]`, c.orderable);
    p.set(`columns[${i}][search][value]`, '');
    p.set(`columns[${i}][search][regex]`, 'false');
  });
  const url = `${BASE_URL}/api/v1/organismos/${orgId}/contratosmenores/table?${p.toString()}`;
  try {
    const res = await httpGet(url, referer);
    if (res.statusCode !== 200) return 0;
    return JSON.parse(res.body).recordsTotal || 0;
  } catch { return 0; }
}

// ─── Fetch contratos menores ─────────────────────────────────────────

async function fetchOrgCM(orgId, dateStart, dateEnd) {
  const referer = `${BASE_URL}/consultaOrganismo.jsp?OR=${orgId}&N=${orgId}&lang=es`;
  const url = `${BASE_URL}/api/v1/organismos/${orgId}/contratosmenores/table`;
  const contratos = [];
  let start = 0;
  let total = null;
  let draw = 1;

  const COLS_CM = [
    { data: 'id', name: 'id', orderable: 'true' },
    { data: 'entidad', name: 'entidad', orderable: 'true' },
    { data: 'objeto', name: 'objeto', orderable: 'true' },
    { data: 'importe', name: 'importe', orderable: 'true' },
    { data: 'publicado', name: 'publicado', orderable: 'true' },
    { data: 'nif', name: 'nif', orderable: 'true' },
    { data: 'adjudicatario', name: 'adjudicatario', orderable: 'true' },
    { data: 'duracion', name: 'duracion', orderable: 'false' },
  ];

  while (true) {
    const p = new URLSearchParams({
      draw: String(draw++), start: String(start), length: String(PAGE_SIZE),
      'search[value]': '', 'search[regex]': 'false',
      'order[0][column]': '4', 'order[0][dir]': 'desc',
      datestart: dateStart, dateend: dateEnd,
      _: String(Date.now()),
    });
    COLS_CM.forEach((c, i) => {
      p.set(`columns[${i}][data]`, c.data);
      p.set(`columns[${i}][name]`, c.name);
      p.set(`columns[${i}][searchable]`, 'true');
      p.set(`columns[${i}][orderable]`, c.orderable);
      p.set(`columns[${i}][search][value]`, '');
      p.set(`columns[${i}][search][regex]`, 'false');
    });

    try {
      const res = await httpGet(`${url}?${p.toString()}`, referer);
      if (res.statusCode !== 200) break;

      const data = JSON.parse(res.body);
      if (total === null) {
        total = data.recordsTotal || 0;
        if (total === 0) break;
        if (total > 2000) total = 2000;
      }

      const recs = data.data || [];
      if (!recs.length) break;

      for (const r of recs) {
        contratos.push({
          id              : `GAL:CM:${r.id}`,
          titulo          : r.objeto || '',
          objeto          : r.objeto || '',
          organismo       : (r.entidad || '').trim(),
          cpv             : '',
          cpvs            : [],
          importe         : normImporte(r.importe),
          importe_num     : parseFloat(r.importe || 0) || 0,
          importe_adjudicacion: parseFloat(r.importe || 0) || 0, // En CM, el importe es el adjudicado
          estado          : 'adjudicada',
          fecha_publicacion: normFecha(r.publicado),
          fecha_fin       : '',
          fecha_modificado: '',
          fuente          : 'Galicia',
          tipo_contrato   : 'contrato menor',
          adjudicatario   : (r.adjudicatario || '').trim(),
          nif_adjudicatario: (r.nif || '').trim(),
          duracion        : (r.duracion || '').trim(),
          url             : `${BASE_URL}/contratoMenor.jsp?N=${r.id}&lang=es`,
          _fuente_file    : 'galicia',
          _tipo           : 'CM',
        });
      }

      start += recs.length;
      if (start >= total) break;
      await sleep(300);
    } catch (err) {
      log(`CM error org ${orgId}: ${err.message}`);
      break;
    }
  }

  return contratos;
}

// ─── Resolución de nombre de organismo (el endpoint LIC no devuelve entidad) ──

const orgNameCache = new Map();

/**
 * Resuelve el nombre del organismo desde la página perfil del contratante.
 * El endpoint /licitaciones/table NO devuelve la columna 'entidad' (verificado
 * en vivo: keys = id,objeto,importe,estado,estadoDesc,publicado,modificado),
 * así que sacamos el nombre del <title> de consultaOrganismo.jsp.
 */
async function resolveOrgName(orgId, referer) {
  if (orgNameCache.has(orgId)) return orgNameCache.get(orgId);
  try {
    const res = await httpGet(`${BASE_URL}/consultaOrganismo.jsp?OR=${orgId}&N=${orgId}&lang=es`, referer);
    if (res.statusCode === 200) {
      const m = res.body.match(/<title>[^<]*?&nbsp;([^<]+?)\s*-\s*Contratos/i) ||
                res.body.match(/<title>([^<]+?)\s*-\s*Contratos/i);
      if (m) {
        const name = m[1].replace(/&nbsp;/g, ' ').trim();
        orgNameCache.set(orgId, name);
        return name;
      }
    }
  } catch (_) {}
  orgNameCache.set(orgId, '');
  return '';
}

// ─── Fetch licitaciones ────────────────────────────────────────────

async function fetchOrgRecent(orgId, cutoff) {
  const referer = `${BASE_URL}/consultaOrganismo.jsp?OR=${orgId}&N=${orgId}&lang=es`;
  const url = `${BASE_URL}/api/v1/organismos/${orgId}/licitaciones/table`;
  const contratos = [];
  let start = 0;
  let total = null;
  let draw = 1;
  let stop = false;
  // El endpoint LIC no devuelve 'entidad'; resuélvelo desde la página perfil.
  const orgName = await resolveOrgName(orgId, referer);

  while (!stop) {
    try {
      const res = await httpGet(`${url}?${buildParams(start, draw++)}`, referer);
      if (res.statusCode !== 200) break;

      const data = JSON.parse(res.body);
      if (total === null) {
        total = data.recordsTotal || 0;
        if (total === 0) break;
      }

      const recs = data.data || [];
      if (!recs.length) break;

      let oldCount = 0;
      for (const r of recs) {
        const fechaISO = normFecha(r.publicado);
        const fechaDate = fechaISO ? new Date(fechaISO) : null;

        if (fechaDate && fechaDate < cutoff) { oldCount++; continue; }
        if (!orgName && r.entidad) orgName = r.entidad.trim();

        contratos.push({
          id              : `GAL:${r.id}`,
          titulo          : r.objeto || '',
          objeto          : r.objeto || '',
          organismo       : orgName || '',
          cpv             : '',
          cpvs            : [],
          importe         : normImporte(r.importe),
          importe_num     : parseFloat(r.importe || 0) || 0,
          estado          : normEstado(r.estadoDesc || ''),
          fecha_publicacion: fechaISO,
          fecha_fin       : '',
          fecha_modificado: normFecha(r.modificado || ''),
          fuente          : 'Galicia',
          tipo_contrato   : '',
          adjudicatario   : '',
          nif_adjudicatario: '',
          url             : `${BASE_URL}/licitacion.jsp?N=${r.id}&lang=es`,
          _fuente_file    : 'galicia',
          _tipo           : 'LIC',
        });
      }

      if (oldCount > recs.length * 0.8) { stop = true; }
      start += recs.length;
      if (start >= total) break;
    } catch (err) {
      log(`LIC error org ${orgId}: ${err.message}`);
      break;
    }
  }

  return contratos;
}

// ─── Main ───────────────────────────────────────────────────────────

async function run() {
  log('=== Iniciando Galicia v2.1 (API REST, paralelismo 5) ===');

  // Init session
  await httpGet(`${BASE_URL}/resultadoIndex.jsp?lang=es`).catch(() => {});
  await sleep(300);

  const cutoff = new Date(Date.now() - DAYS_BACK * 86400000);
  log(`Ventana: últimos ${DAYS_BACK} días`);

  // Phase 1: Discover orgs (probe both LIC and CM)
  log(`Descubriendo organismos (1-${MAX_ORG_ID})...`);
  const activeOrgs = [];
  const allIds = Array.from({ length: MAX_ORG_ID }, (_, i) => i + 1);

  for (let i = 0; i < allIds.length; i += CONCURRENCY) {
    const batch = allIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(id =>
      Promise.all([probeOrg(id), probeOrgCM(id)]).then(([licTotal, cmTotal]) => ({ id, licTotal, cmTotal }))
    ));
    for (const { id, licTotal, cmTotal } of results) {
      if (licTotal > 0 || cmTotal > 0) {
        activeOrgs.push({ id, licTotal, cmTotal, total: licTotal + cmTotal });
      }
    }
  }

  log(`Organismos activos: ${activeOrgs.length} (con datos en LIC o CM)`);

  // Date range for CM
  const dateStart = cutoff.toISOString().substring(0, 10);
  const dateEnd = new Date().toISOString().substring(0, 10);

  // Phase 2: Fetch licitaciones + contratos menores
  const contratos = [];

  // 2a. Licitaciones
  for (let i = 0; i < activeOrgs.length; i += CONCURRENCY) {
    const batch = activeOrgs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(({ id }) => fetchOrgRecent(id, cutoff)));
    for (const recs of results) contratos.push(...recs);
    await sleep(200);
  }

  const licCount = contratos.length;
  log(`Licitaciones recientes: ${licCount}`);

  // 2b. Contratos menores — top 50 orgs by total
  const topOrgs = activeOrgs
    .filter(o => o.cmTotal > 0 || o.licTotal > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 50);
  for (let i = 0; i < topOrgs.length; i += CONCURRENCY) {
    const batch = topOrgs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(({ id }) => fetchOrgCM(id, dateStart, dateEnd)));
    for (const recs of results) contratos.push(...recs);
    await sleep(200);
  }

  log(`Contratos menores: ${contratos.length - licCount}`);
  log(`Total Galicia v2.1: ${contratos.length} contratos en los últimos ${DAYS_BACK} días`);

  if (contratos.length === 0) {
    log('Sin contratos — manteniendo datos anteriores');
    return { total: 0, contratos: [] };
  }

  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, contratos, {
    fuente: 'GALICIA_V2',
    meta: { metodo: 'api_datatables_parallel', version: '2.1' },
    log,
  });

  return { total: stats.total };
}

if (require.main === module) {
  run()
    .then(r => console.log(`✓ Galicia v2.1: ${r.total} contratos`))
    .catch(err => console.error('Error:', err));
}

module.exports = { run };
