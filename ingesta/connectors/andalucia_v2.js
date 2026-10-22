/**
 * Conector Andalucía v2 — ElasticSearch interno del portal angular
 *
 * Fuente: /elastic/sirec_pdc_expedientes/_search (endpoint interno)
 * Total disponible: 852K+ contratos (2010-2026)
 * Método: POST con query DSL, paginación por from+size (máx 10K)
 *         Range filter por fechaPublicacion → últimos DAYS_BACK días
 *
 * Mejoras v2.1 (vs BquantFinance ref):
 *   - Ahora captura CONTRATOS MENORES (proc=9) además de licitaciones estándar
 *   - Más campos: numero_expediente, estado_codigo, codigo_procedimiento,
 *     codigo_tramitacion, forma_presentacion, cofinanciado_ue,
 *     subasta_electronica, sistema_racionalizacion, num_lotes, num_anuncios,
 *     provincias_ejecucion, medios_publicacion, importe_adjudicacion
 *   - Manejo de múltiples adjudicatarios (todos los NIFs)
 *   - Deduplicación robusta por id_expediente
 *
 * Ref: BquantFinance/licitaciones-espana/scripts/ccaa_andalucia.py
 */

'use strict';

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const ES_URL    = 'https://www.juntadeandalucia.es/haciendayadministracionpublica/apl/pdc-front-publico/elastic/sirec_pdc_expedientes/_search';
const REFERER   = 'https://www.juntadeandalucia.es/haciendayadministracionpublica/apl/pdc-front-publico/perfiles-licitaciones/buscador-general';
const DATA_FILE = path.join(__dirname, '..', 'data', 'andalucia_contracts.json');
const LOG_FILE  = path.join(__dirname, '..', 'logs', 'andalucia_v2.log');

const DAYS_BACK   = 30;
const PAGE_SIZE   = 100;
const RATE_MS     = 200;   // ms entre peticiones
const MAX_CONTRATOS = 8000; // cap por ciclo (aumentado por menores)

function log(msg) {
  const line = `[${new Date().toISOString()}] [andalucia_v2] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function postJson(rawUrl, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const payload = JSON.stringify(body);
    const options = {
      hostname : url.hostname,
      path     : url.pathname + url.search,
      method   : 'POST',
      timeout  : 30000,
      headers  : {
        'Content-Type'   : 'application/json',
        'Accept'         : 'application/json',
        'Origin'         : 'https://www.juntadeandalucia.es',
        'Referer'        : REFERER,
        'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Length' : Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(postJson(res.headers.location, body));
      }
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

function normEstado(e) {
  if (!e) return 'desconocido';
  const cod = (e.codigo || '').toUpperCase();
  const map = {
    'PUB': 'publicada', 'ABT': 'abierta', 'LIC': 'abierta',
    'EV': 'evaluacion', 'EVA': 'evaluacion', 'ADJ': 'adjudicada',
    'RES': 'resuelta', 'FOR': 'formalizada', 'ANL': 'anulada',
    'DES': 'desistida', 'PRE': 'anuncio_previo', 'REN': 'renuncia',
    'PEN': 'pendiente', 'CER': 'cerrada', 'REV': 'revision',
    'ABD': 'abandonada', 'PAA': 'paralizada',
  };
  return map[cod] || (e.nombre || cod).toLowerCase();
}

function normCpv(cpvs) {
  if (!cpvs || !cpvs.length) return '';
  return cpvs[0].replace(/-\d+$/, '');
}

function normImporte(val) {
  if (!val || val === 0) return '—';
  if (val >= 1e9) return `€ ${(val/1e9).toFixed(2)}B`;
  if (val >= 1e6) return `€ ${(val/1e6).toFixed(2)}M`;
  if (val >= 1e3) return `€ ${Math.round(val/1e3)}K`;
  return `€ ${Math.round(val)}`;
}

function _dt(value) {
  if (!value) return '';
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : String(value).substring(0, 10);
}

function mapContrato(src) {
  const adjudicaciones = src.adjudicaciones || [];
  const firstAward = adjudicaciones[0] || {};

  // Múltiples adjudicatarios
  let todosNifs = '';
  if (adjudicaciones.length > 1) {
    todosNifs = adjudicaciones
      .map(a => (a.nifAdjudicatario || '').replace(/;$/, ''))
      .filter(Boolean)
      .join('; ');
  }

  // Provincias de ejecución
  let provincias = '';
  const provs = src.provinciasEjecucion || [];
  if (Array.isArray(provs) && provs.length) {
    provincias = provs.map(p => String(p)).join('; ');
  }

  // Medios de publicación
  let medios = '';
  const mediosArr = src.mediosPublicacion || [];
  if (Array.isArray(mediosArr) && mediosArr.length) {
    medios = mediosArr.map(m => (m.codigo || '')).filter(Boolean).join('; ');
  }

  // Anuncios (fechas primera/última)
  let anuncioPrimera = '';
  let anuncioUltima = '';
  const anuncios = src.anuncios || [];
  if (Array.isArray(anuncios) && anuncios.length) {
    const fechas = anuncios
      .map(a => a.fechaPublicacion)
      .filter(Boolean)
      .sort();
    if (fechas.length) {
      anuncioPrimera = _dt(fechas[0]);
      anuncioUltima = _dt(fechas[fechas.length - 1]);
    }
  }

  return {
    id               : `AND:${src.idExpediente}`,
    numero_expediente: src.numeroExpediente || '',
    titulo           : src.titulo || '',
    objeto           : src.titulo || '',
    organismo        : (src.perfilContratante || {}).descripcion || '',
    codigo_perfil    : (src.perfilContratante || {}).codigo || '',
    codigo_dir3      : (src.perfilContratante || {}).codigoDir3 || '',
    cpv              : normCpv(src.codigosCpv || []),
    cpvs             : (src.codigosCpv || []).map(c => c.replace(/-\d+$/, '')),
    importe          : normImporte(src.importeLicitacion || src.valorEstimado),
    importe_num      : src.importeLicitacion || src.valorEstimado || 0,
    importe_adjudicacion: firstAward.importeAdjudicacion || '',
    importe_adjudicacion_iva: firstAward.importeAdjudicacionConIva || '',
    estado           : normEstado(src.estado),
    estado_codigo    : (src.estado || {}).codigo || '',
    fecha_publicacion: (src.fechaPublicacion || '').substring(0, 10),
    fecha_fin        : (src.fechaLimitePresentacion || '').substring(0, 10),
    anuncio_primera_fecha: anuncioPrimera,
    anuncio_ultima_fecha : anuncioUltima,
    fuente           : 'Andalucía',
    tipo_contrato    : (src.tipoContrato || {}).descripcion || '',
    tipo_contrato_codigo: (src.tipoContrato || {}).codigo || '',
    codigo_procedimiento: src.codigoProcedimiento || '',
    codigo_tramitacion  : src.codigoTipoTramitacion || '',
    codigo_normativa    : src.codigoNormativa || '',
    forma_presentacion  : src.formaPresentacion || '',
    cofinanciado_ue     : src.cofinanciadoUE || '',
    subasta_electronica : src.subastaElectronica || '',
    sistema_racionalizacion: src.sistemaRacionalizacion || '',
    provincias_ejecucion: provincias,
    medios_publicacion  : medios,
    num_lotes           : (src.lotes || []).length,
    num_anuncios        : anuncios.length,
    num_adjudicaciones  : adjudicaciones.length,
    adjudicatario       : firstAward.nombreAdjudicatario || '',
    nif_adjudicatario   : (firstAward.nifAdjudicatario || '').replace(/;$/, ''),
    todos_adjudicatarios_nif: todosNifs,
    url             : `https://www.juntadeandalucia.es/haciendayadministracionpublica/apl/pdc-front-publico/perfiles-licitaciones/detalle-licitacion?idExpediente=${src.idExpediente}`,
    _fuente_file    : 'andalucia',
  };
}

// ─── Fetch con query personalizada ──────────────────────────────────

async function fetchWithQuery(body, label = '') {
  let attempts = 0;
  while (attempts < 3) {
    try {
      const res = await postJson(ES_URL, body);
      if (res.statusCode === 200) {
        return JSON.parse(res.body);
      }
      log(`HTTP ${res.statusCode} ${label}`);
    } catch (err) {
      log(`ERROR: ${err.message} ${label}`);
    }
    attempts++;
    await sleep(1000 * attempts);
  }
  return null;
}

async function fetchPage(dateFrom, from, sort, extraMust = []) {
  const must = [
    { range: { fechaPublicacion: { gte: dateFrom } } },
    ...extraMust,
  ];
  const body = {
    query: { bool: { must } },
    size : PAGE_SIZE,
    from : from,
    sort : Array.isArray(sort) ? sort : [{ [sort]: 'desc' }],
    track_total_hits: true,
    _source: true,
  };
  return fetchWithQuery(body, `(from=${from}, sort=${JSON.stringify(sort)})`);
}

// ─── Scrape principal ───────────────────────────────────────────────

async function scrapeSorts(dateFrom, sorts, extraMust, label, seen, contratos) {
  for (const sort of sorts) {
    const sortName = Array.isArray(sort)
      ? sort.map(s => `${Object.keys(s)[0]}:${Object.values(s)[0]}`).join(',')
      : sort;
    log(`  ${label} Sort: ${sortName}`);
    let from = 0;
    let total = null;
    let consecutiveEmpty = 0;

    while (true) {
      const data = await fetchPage(dateFrom, from, sort, extraMust);
      if (!data) { log(`  Sin respuesta para sort=${sortName}`); break; }

      const hits = data.hits || {};
      if (total === null) {
        total = (hits.total || {}).value || 0;
        log(`  Total disponible con sort=${sortName}: ${total}`);
      }

      const items = hits.hits || [];
      if (!items.length) break;

      let newInPage = 0;
      for (const h of items) {
        const src = h._source || {};
        const key = String(src.idExpediente);
        if (!seen.has(key)) {
          seen.add(key);
          contratos.push(mapContrato(src));
          newInPage++;
        }
      }

      log(`  from=${from}: ${items.length} items, ${newInPage} nuevos, total acumulado: ${contratos.length}`);
      from += PAGE_SIZE;

      if (newInPage === 0) { consecutiveEmpty++; if (consecutiveEmpty >= 2) break; }
      else consecutiveEmpty = 0;

      if (contratos.length >= MAX_CONTRATOS) { log(`  Cap ${MAX_CONTRATOS} alcanzado`); break; }
      if (from >= Math.min(total, 9900)) break;
      await sleep(RATE_MS);
    }
  }
}

async function run() {
  log('=== Iniciando Andalucía v2.1 (ElasticSearch + Menores) ===');

  const cutoffDate = new Date(Date.now() - DAYS_BACK * 86400000);
  const dateFrom = cutoffDate.toISOString().substring(0, 10);
  log(`Ventana: últimos ${DAYS_BACK} días (desde ${dateFrom})`);

  const seen = new Set();
  const contratos = [];

  // ─── 1. Licitaciones estándar (excluir proc=9 = menores) ─────────
  log('--- Fase 1: Licitaciones estándar ---');
  const stdSorts = [
    'fechaPublicacion',
    'idExpediente',
    'importeLicitacion',
  ];
  // Excluir contratos menores (codigoProcedimiento=9) y estado BRR (borrador)
  const stdMustNot = [
    { match: { 'estado.codigo': 'BRR' } },
    { match: { codigoProcedimiento: 9 } },
  ];

  // Como ES no soporta must_not directamente en bool.must, usamos bool.must_not
  // Reconstruimos el body para estándar
  const stdBodyBase = {
    query: {
      bool: {
        must: [{ range: { fechaPublicacion: { gte: dateFrom } } }],
        must_not: stdMustNot,
      },
    },
  };

  // Para el scrape estándar usamos los sorts normales
  for (const sort of stdSorts) {
    const sortName = typeof sort === 'string' ? sort : JSON.stringify(sort);
    log(`  STD Sort: ${sortName}`);
    let from = 0;
    let total = null;
    let consecutiveEmpty = 0;

    while (true) {
      const body = {
        query: {
          bool: {
            must: [{ range: { fechaPublicacion: { gte: dateFrom } } }],
            must_not: stdMustNot,
          },
        },
        size: PAGE_SIZE,
        from,
        sort: typeof sort === 'string' ? [{ [sort]: 'desc' }] : [sort],
        track_total_hits: true,
        _source: true,
      };
      const data = await fetchWithQuery(body, `STD(from=${from})`);
      if (!data) break;

      const hits = data.hits || {};
      if (total === null) {
        total = (hits.total || {}).value || 0;
        log(`  Total STD disponible: ${total}`);
      }

      const items = hits.hits || [];
      if (!items.length) break;

      let newInPage = 0;
      for (const h of items) {
        const src = h._source || {};
        const key = String(src.idExpediente);
        if (!seen.has(key)) {
          seen.add(key);
          contratos.push(mapContrato(src));
          newInPage++;
        }
      }

      log(`  STD from=${from}: ${items.length} items, ${newInPage} nuevos, acum: ${contratos.length}`);
      from += PAGE_SIZE;

      if (newInPage === 0) { consecutiveEmpty++; if (consecutiveEmpty >= 2) break; }
      else consecutiveEmpty = 0;

      if (contratos.length >= MAX_CONTRATOS) break;
      if (from >= Math.min(total || 0, 9900)) break;
      await sleep(RATE_MS);
    }
  }

  const stdCount = contratos.length;
  log(`Licitaciones estándar: ${stdCount}`);

  // ─── 2. Contratos menores (proc=9) ────────────────────────────────
  log('--- Fase 2: Contratos menores (proc=9) ---');
  const menSorts = [
    'fechaPublicacion',
    'idExpediente',
  ];

  for (const sort of menSorts) {
    const sortName = typeof sort === 'string' ? sort : JSON.stringify(sort);
    log(`  MEN Sort: ${sortName}`);
    let from = 0;
    let total = null;
    let consecutiveEmpty = 0;

    while (true) {
      const body = {
        query: {
          bool: {
            must: [
              { range: { fechaPublicacion: { gte: dateFrom } } },
              { match: { codigoProcedimiento: 9 } },
            ],
            must_not: [{ match: { 'estado.codigo': 'BRR' } }],
          },
        },
        size: PAGE_SIZE,
        from,
        sort: typeof sort === 'string' ? [{ [sort]: 'desc' }] : [sort],
        track_total_hits: true,
        _source: true,
      };
      const data = await fetchWithQuery(body, `MEN(from=${from})`);
      if (!data) break;

      const hits = data.hits || {};
      if (total === null) {
        total = (hits.total || {}).value || 0;
        log(`  Total MEN disponible: ${total}`);
      }

      const items = hits.hits || [];
      if (!items.length) break;

      let newInPage = 0;
      for (const h of items) {
        const src = h._source || {};
        const key = String(src.idExpediente);
        if (!seen.has(key)) {
          seen.add(key);
          contratos.push(mapContrato(src));
          newInPage++;
        }
      }

      log(`  MEN from=${from}: ${items.length} items, ${newInPage} nuevos, acum: ${contratos.length}`);
      from += PAGE_SIZE;

      if (newInPage === 0) { consecutiveEmpty++; if (consecutiveEmpty >= 2) break; }
      else consecutiveEmpty = 0;

      if (contratos.length >= MAX_CONTRATOS) break;
      if (from >= Math.min(total || 0, 9900)) break;
      await sleep(RATE_MS);
    }
  }

  const menCount = contratos.length - stdCount;
  log(`Contratos menores: ${menCount}`);

  log(`Total Andalucía v2.1: ${contratos.length} contratos únicos (${stdCount} std + ${menCount} menores)`);

  if (contratos.length === 0) {
    log('Sin contratos nuevos — manteniendo datos anteriores');
    return { total: 0 };
  }

  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, contratos, {
    fuente: 'ANDALUCIA_V2',
    meta: { metodo: 'elasticsearch', version: '2.1', fases: ['std', 'menores'] },
    log,
  });
  log(`Guardados en ${DATA_FILE}`);

  return { total: stats.total, std: stdCount, menores: menCount };
}

if (require.main === module) {
  run()
    .then(r => console.log(`✓ Andalucía v2.1: ${r.total} contratos (${r.std || 0} std + ${r.menores || 0} menores)`))
    .catch(err => console.error('Error:', err));
}

module.exports = { run };
