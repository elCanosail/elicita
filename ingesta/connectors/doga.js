/**
 * Conector DOGA/Galicia — Plataforma de Contratación del Sector Público (PLACE)
 *
 * Fuente: Feed Atom de PLACE (https://contrataciondelestado.es)
 * Filtrado: contratos de organismos gallegos (detección via ParentLocatedParty = "Galicia")
 *           + Todos los contratos (sin filtro CPV)
 *
 * Por qué PLACE y no contratosdegalicia.gal directamente:
 *   - contratosdegalicia.gal protege sus búsquedas con reCAPTCHA v3 → no accesible sin browser
 *   - PLACE publica un feed Atom público, paginado, sin autenticación
 *   - Galicia republica sus contratos en PLACE por obligación legal (interoperabilidad)
 *   - Cubre Xunta, Diputaciones, Concellos y entidades del sector público gallego
 *
 * Estrategia de paginación:
 *   - El feed es cronológico inverso (más recientes primero)
 *   - Cada página enlaza a la siguiente via rel="next"
 *   - Paramos cuando la fecha del último entry supera 30 días
 */

'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');

const PLACE_FEED_BASE = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const DATA_FILE       = path.join(__dirname, '..', 'data', 'doga_contracts.json');
const LOG_FILE        = path.join(__dirname, '..', 'logs', 'doga.log');

// CPVs objetivo — perfil cliente Norcontrol (inspección, ensayos, ingeniería)
const CPV_PREFIXES = [
  '71310000',  // Servicios de consultoría en ingeniería civil
  '71600000',  // Ensayos y verificación técnica
  '71630000',  // Inspección y ensayo técnico
  '71350000',  // Geotecnia
  '71351000',  // Exploración del subsuelo
];

// CPVs en modo prefijo (división 71 = servicios de ingeniería)
// Si se activa modo amplio, se capturan todos los CPV que empiecen por estas divisiones
const CPV_DIVISION_FALLBACK = ['713', '716'];

// Ventana temporal máxima
const DAYS_BACK       = 30;
const MAX_PAGES       = 15;   // servidor PLACE lento en págs 2+ (~30s/página), limitar a 15
const RETRY_ATTEMPTS  = 3;
const RETRY_DELAY_MS  = 2000;

// ─── Utils ───────────────────────────────────────────────────────────────────

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
    const parsed   = new url.URL(rawUrl);
    const lib      = parsed.protocol === 'https:' ? https : http;
    const options  = {
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
      // Manejar redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new url.URL(res.headers.location, rawUrl).toString();
        resolve(fetchUrl(redirectUrl, attempt));
        return;
      }

      if (res.statusCode !== 200) {
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

// ─── Parser XML minimalista (sin dependencias) ────────────────────────────────

/**
 * Extrae el valor de texto de todas las ocurrencias de una etiqueta.
 * No es un parser completo — es suficiente para el formato PLACE.
 */
function extractAll(xml, tag) {
  const results = [];
  const re      = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

function extractFirst(xml, tag) {
  const all = extractAll(xml, tag);
  return all.length > 0 ? all[0] : '';
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'g');
  const m  = re.exec(xml);
  return m ? m[1] : '';
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

// ─── Lógica de filtrado ───────────────────────────────────────────────────────

function isGalicia(entryXml) {
  // Busca "Galicia" en cualquier ParentLocatedParty/PartyName/Name
  const names = extractAll(entryXml, 'cbc:Name');
  return names.some(n => n.trim() === 'Galicia');
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

// Mapeo de estados PLACE → formato unificado
const ESTADO_MAP = {
  PRE:  'previa',
  PUB:  'abierta',
  EV:   'evaluacion',
  ADJ:  'adjudicada',
  RES:  'resuelta',
  ANU:  'anulada',
  DEL:  'eliminada',
};

function mapEstado(code) {
  return ESTADO_MAP[code] || code.toLowerCase() || 'desconocido';
}

// ─── Normalización ────────────────────────────────────────────────────────────

function normalizeEntry(entryXml) {
  try {
    // ID único de PLACE
    const idUrl     = extractFirst(entryXml, 'id').trim();
    const idMatch   = idUrl.match(/\/(\d+)$/);
    const placeId   = idMatch ? idMatch[1] : idUrl;

    // Título
    const titulo    = decodeEntities(extractFirst(entryXml, 'title').trim());

    // Fecha de publicación
    const updated   = extractFirst(entryXml, 'updated').trim();

    // Link al detalle
    const linkMatch = entryXml.match(/<link href="([^"]+)"/);
    const urlFuente = linkMatch ? decodeEntities(linkMatch[1]) : '';

    // ContractFolderStatus block
    const statusBlock = (() => {
      const m = entryXml.match(/<cac-place-ext:ContractFolderStatus>([\s\S]*?)<\/cac-place-ext:ContractFolderStatus>/);
      return m ? m[1] : entryXml;
    })();

    // Expediente
    const expediente = extractFirst(statusBlock, 'cbc:ContractFolderID').trim();

    // Estado
    const estadoCode = (() => {
      const m = statusBlock.match(/<cbc-place-ext:ContractFolderStatusCode[^>]*>([^<]+)<\/cbc-place-ext:ContractFolderStatusCode>/);
      return m ? m[1].trim() : '';
    })();

    // Organismo — primer PartyName en LocatedContractingParty
    const partyBlock = (() => {
      const m = statusBlock.match(/<cac-place-ext:LocatedContractingParty>([\s\S]*?)<\/cac-place-ext:LocatedContractingParty>/);
      return m ? m[1] : '';
    })();

    const allPartyNames = extractAll(partyBlock, 'cbc:Name');
    const organismo     = allPartyNames.length > 0 ? decodeEntities(allPartyNames[0]) : 'Organismo no especificado';

    // CPVs
    const cpvs = extractCPVs(statusBlock);

    // Importe (sin IVA preferentemente)
    const importeMatch = statusBlock.match(/<cbc:TaxExclusiveAmount[^>]*>([^<]+)<\/cbc:TaxExclusiveAmount>/);
    const importeAlt   = statusBlock.match(/<cbc:EstimatedOverallContractAmount[^>]*>([^<]+)<\/cbc:EstimatedOverallContractAmount>/);
    const importe      = parseFloat(
      (importeMatch ? importeMatch[1] : importeAlt ? importeAlt[1] : '0').trim()
    ) || 0;

    // Fecha fin presentación — no siempre está en el feed Atom, buscar SubsidiaryDeadlineDate
    const deadlineMatch = statusBlock.match(/<cbc:(?:SubsidiaryDeadline|TenderSubm)[a-zA-Z]*Date[^>]*>([^<]+)<\/cbc:[^>]+>/);
    const fechaFin      = deadlineMatch ? deadlineMatch[1].trim() : null;

    return {
      id:                     `PLACE:${placeId}`,
      fuente:                 'DOGA',
      expediente:             expediente || placeId,
      titulo:                 titulo,
      organismo:              organismo,
      cpvs:                   [...new Set(cpvs)],
      importe_licitacion:     importe,
      fecha_publicacion:      updated,
      fecha_fin_presentacion: fechaFin,
      estado:                 mapEstado(estadoCode),
      url_fuente:             urlFuente,
    };
  } catch (err) {
    log(`  ✗ Error normalizando entry: ${err.message}`);
    return null;
  }
}

// ─── Parser de página Atom ────────────────────────────────────────────────────

function parseFeedPage(xml) {
  // Extraer link "next" — el feed PLACE pone href antes de rel
  // <link href="..." rel="next"/> o <link rel="next" href="..."/>
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

  // Extraer todos los <entry>
  const entries   = [];
  const entryRe   = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    entries.push(m[1]);
  }

  return { nextUrl, entries };
}

// ─── Runner principal ─────────────────────────────────────────────────────────

async function run() {
  log('=== Inicio ingesta DOGA/PLACE ===');
  log(`  Fuente: ${PLACE_FEED_BASE}`);
  log(`  Ventana: últimos ${DAYS_BACK} días`);
  log(`  CPVs objetivo: ${CPV_PREFIXES.join(', ')}`);

  ensureDir(DATA_FILE);
  ensureDir(LOG_FILE);

  const cutoff  = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);
  const todos   = [];
  const vistos  = new Set();

  let currentUrl = PLACE_FEED_BASE;
  let page       = 0;
  let stop       = false;

  while (currentUrl && page < MAX_PAGES && !stop) {
    page++;
    log(`  → Página ${page}: ${currentUrl}`);

    let xml;
    try {
      xml = await fetchUrl(currentUrl);
    } catch (err) {
      log(`  ✗ Error descargando página ${page}: ${err.message}`);
      break;
    }

    const { nextUrl, entries } = parseFeedPage(xml);

    if (entries.length === 0) {
      log(`  ! Página ${page} sin entries — fin del feed`);
      break;
    }

    let paginaGalicia = 0;
    let paginaTotal   = entries.length;
    let paginaOld     = 0;

    for (const entryXml of entries) {
      // Comprobar fecha
      const updatedStr = extractFirst(entryXml, 'updated').trim();
      if (updatedStr) {
        const entryDate = new Date(updatedStr);
        if (entryDate < cutoff) {
          paginaOld++;
          // Si más de la mitad de entries son viejos, parar
          if (paginaOld > paginaTotal * 0.7) {
            log(`  ⏹ ${paginaOld}/${paginaTotal} entries fuera de ventana — deteniendo`);
            stop = true;
          }
          continue;
        }
      }

      // Filtrar Galicia
      if (!isGalicia(entryXml)) continue;
      paginaGalicia++;

      const normalizado = normalizeEntry(entryXml);
      if (!normalizado) continue;

      // Deduplicar
      if (vistos.has(normalizado.id)) continue;
      vistos.add(normalizado.id);

      todos.push(normalizado);
    }

    log(`  ✓ Página ${page}: ${paginaGalicia} contratos gallegos de ${paginaTotal} totales (acumulado: ${todos.length})`);

    if (!nextUrl || stop) break;

    currentUrl = nextUrl;
    await sleep(500); // cortés con el servidor
  }

  // Si no hay resultados con CPV específico, mostrar advertencia pero guardar todos los gallegos
  const conCPV    = todos.filter(c => matchesCPV(c.cpvs));
  const sinFiltro = todos;

  log(`\n  📊 Resumen:`);
  log(`     Contratos gallegos totales: ${sinFiltro.length}`);
  log(`     Con CPV ingeniería (71xxx):     ${conCPV.length}`);

  // Guardamos TODOS los gallegos (el filtro CPV lo aplica elicita en la BD)
  // pero marcamos cuáles coinciden con el perfil cliente
  const todosAnotados = sinFiltro.map(c => ({
    ...c,
    perfil_match: matchesCPV(c.cpvs),
  }));

  if (todosAnotados.length === 0) {
    log && log(`Sin contratos — manteniendo datos anteriores`);
    return { total: 0, contratos: [] };
  }

  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, todosAnotados, {
    fuente: 'DOGA',
    meta: {
      fuente_tecnica: 'PLACE (Plataforma de Contratación del Sector Público)',
      nota: 'Contratos de organismos gallegos detectados por ParentLocatedParty=Galicia en el feed Atom de PLACE',
      total_cpv_match: conCPV.length,
    },
    log,
  });
  log('=== Fin ingesta DOGA/PLACE ===\n');

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
