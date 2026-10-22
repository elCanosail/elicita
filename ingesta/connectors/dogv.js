/**
 * Conector DOGV — Diari Oficial de la Generalitat Valenciana
 * Fuente: Feed Atom de PLACE (Plataforma de Contratación del Sector Público)
 *
 * Por qué PLACE y no DOGV directamente:
 *   - dogv.gva.es es un portal Liferay, sin feed RSS estructurado de contratación
 *   - PLACE publica un feed Atom público con todos los contratos del sector público español
 *   - Los organismos de la Comunitat Valenciana publican en PLACE por obligación legal
 *   - Detección: ParentLocatedParty con "Comunidad Valenciana" en la jerarquía
 *
 * Estrategia:
 *   1. Descargar feed Atom de PLACE (paginado)
 *   2. Filtrar entries con ParentLocatedParty = "Comunidad Valenciana"
 *   3. Aplicar filtro CPV/keywords perfil cliente Norcontrol
 *   4. Normalizar y guardar en dogv_contracts.json
 *
 * Rate limit: 0.5 req/segundo (2s de pausa entre páginas)
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PLACE_FEED_BASE = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const DATA_FILE       = path.join(__dirname, '..', 'data', 'dogv_contracts.json');
const LOG_FILE        = path.join(__dirname, '..', 'logs', 'dogv.log');

// CPVs objetivo — perfil cliente Norcontrol
const CPV_PREFIXES = [
  '71310000',
  '71600000',
  '71630000',
  '71350000',
  '71351000',
];

const CPV_DIVISION_FALLBACK = ['713', '716'];

const DAYS_BACK      = 30;
const MAX_PAGES      = 15; // ~5-10 min, cubre ventana de 7 días para CV
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const PAGE_DELAY_MS  = 500; // ~2 req/s (feed público, no hay rate limit estricto)

// ─── Utils ────────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── HTTP con reintentos ──────────────────────────────────────────────────────

function fetchUrl(rawUrl, attempt = 1) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(rawUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  {
        'User-Agent': 'Mozilla/5.0 (compatible; elicita-ingesta/1.0)',
        'Accept':     'application/atom+xml, application/xml, text/xml, */*',
      },
      timeout: 30000,
    };

    const req = lib.request(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new url.URL(res.headers.location, rawUrl).toString();
        resolve(fetchUrl(redirectUrl, attempt));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} para ${rawUrl}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout en ${rawUrl}`)); });
    req.on('error', reject);
    req.end();
  }).catch(async err => {
    if (attempt < RETRY_ATTEMPTS) {
      log(`  ⚠ Reintento ${attempt}/${RETRY_ATTEMPTS}: ${err.message}`);
      await sleep(RETRY_DELAY_MS * attempt);
      return fetchUrl(rawUrl, attempt + 1);
    }
    throw err;
  });
}

// ─── XML helpers ─────────────────────────────────────────────────────────────

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

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

// ─── Filtrado ─────────────────────────────────────────────────────────────────

/**
 * Detecta si un entry pertenece a un organismo de la Comunitat Valenciana.
 * Busca "Comunidad Valenciana" en cualquier nivel de ParentLocatedParty.
 */
function isComunidadValenciana(entryXml) {
  const names = extractAll(entryXml, 'cbc:Name');
  return names.some(n => {
    const t = n.trim();
    return t === 'Comunidad Valenciana' || t === 'Comunitat Valenciana';
  });
}

function extractCPVs(entryXml) {
  return extractAll(entryXml, 'cbc:ItemClassificationCode')
    .map(c => c.trim())
    .filter(Boolean);
}

function matchesCPV(cpvs) {
  if (cpvs.length === 0) return false;
  return cpvs.some(cpv =>
    CPV_PREFIXES.some(target => cpv.startsWith(target.slice(0, 5))) ||
    CPV_DIVISION_FALLBACK.some(div => cpv.startsWith(div))
  );
}

const ESTADO_MAP = {
  PRE: 'previa',
  PUB: 'abierta',
  EV:  'evaluacion',
  ADJ: 'adjudicada',
  RES: 'resuelta',
  ANU: 'anulada',
  DEL: 'eliminada',
};

function mapEstado(code) {
  return ESTADO_MAP[code] || (code || 'desconocido').toLowerCase();
}

// ─── Normalización ────────────────────────────────────────────────────────────

function normalizeEntry(entryXml) {
  try {
    const idUrl   = extractFirst(entryXml, 'id').trim();
    const idMatch = idUrl.match(/\/(\d+)$/);
    const placeId = idMatch ? idMatch[1] : idUrl;

    const titulo    = decodeEntities(extractFirst(entryXml, 'title').trim());
    const updated   = extractFirst(entryXml, 'updated').trim();

    const linkMatch = entryXml.match(/<link href="([^"]+)"/);
    const urlFuente = linkMatch ? decodeEntities(linkMatch[1]) : '';

    const statusBlock = (() => {
      const m = entryXml.match(/<cac-place-ext:ContractFolderStatus>([\s\S]*?)<\/cac-place-ext:ContractFolderStatus>/);
      return m ? m[1] : entryXml;
    })();

    const expediente = extractFirst(statusBlock, 'cbc:ContractFolderID').trim();

    const estadoCode = (() => {
      const m = statusBlock.match(/<cbc-place-ext:ContractFolderStatusCode[^>]*>([^<]+)<\/cbc-place-ext:ContractFolderStatusCode>/);
      return m ? m[1].trim() : '';
    })();

    const partyBlock = (() => {
      const m = statusBlock.match(/<cac-place-ext:LocatedContractingParty>([\s\S]*?)<\/cac-place-ext:LocatedContractingParty>/);
      return m ? m[1] : '';
    })();

    const allPartyNames = extractAll(partyBlock, 'cbc:Name');
    const organismo = allPartyNames.length > 0 ? decodeEntities(allPartyNames[0]) : 'Organismo no especificado';

    const cpvs = extractCPVs(statusBlock);

    const importeMatch = statusBlock.match(/<cbc:TaxExclusiveAmount[^>]*>([^<]+)<\/cbc:TaxExclusiveAmount>/);
    const importeAlt   = statusBlock.match(/<cbc:EstimatedOverallContractAmount[^>]*>([^<]+)<\/cbc:EstimatedOverallContractAmount>/);
    const importe = parseFloat(
      (importeMatch ? importeMatch[1] : importeAlt ? importeAlt[1] : '0').trim()
    ) || 0;

    // Fecha límite presentación
    const deadlineMatch = statusBlock.match(/<cbc:(?:SubsidiaryDeadline|TenderSubm)[a-zA-Z]*Date[^>]*>([^<]+)<\/cbc:[^>]+>/);
    const fechaFin = deadlineMatch ? deadlineMatch[1].trim() : null;

    // Provincia (nivel provincia dentro de CV)
    let provincia = '';
    const parentParties = statusBlock.match(/<cac-place-ext:ParentLocatedParty>([\s\S]*?)<\/cac-place-ext:ParentLocatedParty>/g) || [];
    for (const pp of parentParties) {
      const ppNames = extractAll(pp, 'cbc:Name');
      // La provincia está entre el organismo y "Comunidad Valenciana"
      for (const n of ppNames) {
        const t = n.trim();
        if (t !== organismo && t !== 'Comunidad Valenciana' && t !== 'Comunitat Valenciana' &&
            !t.includes('Sector Público') && !t.includes('ENTIDADES')) {
          if (!provincia) provincia = decodeEntities(t);
        }
      }
    }

    return {
      id: `DOGV:${placeId}`,
      fuente: 'DOGV',
      expediente: expediente || placeId,
      objeto: titulo,
      organismo,
      provincia: provincia || 'Comunitat Valenciana',
      cpv: cpvs.length > 0 ? cpvs[0] : '',
      cpvs: [...new Set(cpvs)],
      importe: importe > 0 ? `${importe} EUR` : '',
      importe_licitacion: importe,
      fecha_publicacion: updated ? updated.slice(0, 10) : '',
      fecha_fin_presentacion: fechaFin,
      estado: mapEstado(estadoCode),
      url: urlFuente,
      url_fuente: urlFuente,
      perfil_match: matchesCPV(cpvs),
      _place_id: placeId,
      _estado_code: estadoCode,
    };
  } catch (err) {
    log(`  ✗ Error normalizando entry: ${err.message}`);
    return null;
  }
}

// ─── Parser de página Atom ────────────────────────────────────────────────────

function parseFeedPage(xml) {
  let nextUrl = null;
  const nextRe = /<link([^>]+)>/g;
  let lm;
  while ((lm = nextRe.exec(xml)) !== null) {
    const attrs = lm[1];
    if (attrs.includes('rel="next"')) {
      const hm = attrs.match(/href="([^"]+)"/);
      if (hm) { nextUrl = decodeEntities(hm[1]); break; }
    }
  }

  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) entries.push(m[1]);

  return { nextUrl, entries };
}

// ─── Runner principal ─────────────────────────────────────────────────────────

async function run() {
  log('=== Inicio ingesta DOGV/PLACE (Comunitat Valenciana) ===');
  log(`  Fuente: ${PLACE_FEED_BASE}`);
  log(`  Filtro: Comunidad Valenciana / Comunitat Valenciana`);
  log(`  Ventana: últimos ${DAYS_BACK} días`);

  ensureDir(DATA_FILE);
  ensureDir(LOG_FILE);

  const cutoff = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);
  const todos  = [];
  const vistos = new Set();

  let currentUrl = PLACE_FEED_BASE;
  let page       = 0;
  let stop       = false;

  while (currentUrl && page < MAX_PAGES && !stop) {
    page++;
    log(`  → Página ${page}: ${currentUrl.slice(0, 80)}...`);

    let xml;
    try {
      xml = await fetchUrl(currentUrl);
    } catch (err) {
      log(`  ✗ Error página ${page}: ${err.message}`);
      break;
    }

    const { nextUrl, entries } = parseFeedPage(xml);

    if (entries.length === 0) {
      log(`  ! Página ${page} sin entries — fin del feed`);
      break;
    }

    let paginaCV    = 0;
    let paginaTotal = entries.length;
    let paginaOld   = 0;

    for (const entryXml of entries) {
      const updatedStr = extractFirst(entryXml, 'updated').trim();
      if (updatedStr) {
        const entryDate = new Date(updatedStr);
        if (entryDate < cutoff) {
          paginaOld++;
          if (paginaOld > paginaTotal * 0.7) {
            log(`  ⏹ ${paginaOld}/${paginaTotal} entries fuera de ventana — deteniendo`);
            stop = true;
          }
          continue;
        }
      }

      if (!isComunidadValenciana(entryXml)) continue;
      paginaCV++;

      const normalizado = normalizeEntry(entryXml);
      if (!normalizado) continue;

      if (vistos.has(normalizado.id)) continue;
      vistos.add(normalizado.id);

      todos.push(normalizado);
    }

    log(`  ✓ Página ${page}: ${paginaCV} contratos valencianos de ${paginaTotal} (acumulado: ${todos.length})`);

    if (!nextUrl || stop) break;

    currentUrl = nextUrl;
    await sleep(PAGE_DELAY_MS); // rate limit 0.5 req/s
  }

  const conCPV    = todos.filter(c => c.perfil_match);
  log(`\n  📊 Resumen DOGV:`);
  log(`     Contratos CV totales: ${todos.length}`);
  log(`     Con CPV ingeniería (71xxx): ${conCPV.length}`);

  if (todos.length === 0) {
    log && log(`Sin contratos — manteniendo datos anteriores`);
    return { total: 0, contratos: [] };
  }

  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, todos, {
    fuente: 'DOGV',
    meta: {
      fuente_tecnica: 'PLACE (Plataforma de Contratación del Sector Público)',
      nota: 'Contratos de organismos de la Comunitat Valenciana detectados por ParentLocatedParty en el feed Atom de PLACE',
      total_cpv_match: conCPV.length,
    },
    log,
  });
  log('=== Fin ingesta DOGV/PLACE ===\n');

  return { total: stats.total, contratos: [] };
}

module.exports = { run };

if (require.main === module) {
  run().catch(err => {
    log(`ERROR FATAL: ${err.message}`);
    log(err.stack);
    process.exit(1);
  });
}
