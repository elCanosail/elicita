/**
 * Conector BOE — Boletín Oficial del Estado
 * Sección V.A: "Anuncios - A. Contratación del Sector Público"
 *
 * Estrategia de ingesta (optimizada):
 *   1. API sumario diario: https://www.boe.es/datosabiertos/api/boe/sumario/YYYYMMDD
 *      → devuelve JSON con estructura diario/sección/departamento/item
 *   2. Filtramos sección código "5A" (V. Anuncios - A. Contratación del Sector Público)
 *   3. Filtrado por keywords en título ANTES de descargar XML (ahorra requests)
 *   4. Paralelismo controlado: 3 XMLs en paralelo
 *   5. Cache: skip si el id ya está en boe_contracts.json
 *
 * Rate limit: 1 req/segundo para no sobrecargar boe.es
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// DuckDB para resolver NIFs enmascarados vía nif_canonical
// Usa Python (duckdb ya instalado) vía child_process en lugar del módulo Node pesado
const { execSync } = require('child_process');

/**
 * Resuelve NIFs enmascarados del BOE (ej: "****3443*") usando el nombre
 * del adjudicatario contra nif_canonical (488K registros).
 * Usa Python+duckdb en lugar del módulo Node.
 *
 * Estrategia:
 *   1. Buscar nombre exacto en nif_canonical
 *   2. Si hay matches, validar que el fragmento visible del NIF enmascarado
 *      coincide con la posición correspondiente del NIF canónico
 *   3. Si hay un único match válido → devolver NIF canónico completo
 *   4. Si hay múltiples matches válidos → devolver el primero + flag ambiguo
 *   5. Si no hay match → devolver NIF enmascarado original
 */
function resolveMaskedNifSync(maskedNif, adjudicatarioName) {
  if (!maskedNif || !maskedNif.includes('*')) return { nif: maskedNif, resolved: false, ambiguous: false };
  if (!adjudicatarioName) return { nif: maskedNif, resolved: false, ambiguous: false };

  // Normalizar nombre para el lookup
  const normName = adjudicatarioName
    .replace(/,/g, '').replace(/\./g, '')
    .replace(/\bS\.?L\.?U\.?\b/gi, '').replace(/\bS\.?A\.?U\.?\b/gi, '')
    .replace(/\bS\.?L\.?\b/gi, '').replace(/\bS\.?A\.?\b/gi, '')
    .replace(/\bS\.?C\.?\b/gi, '').replace(/\bS\.?L\.?P\.?\b/gi, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();

  if (!normName || normName.length < 3) return { nif: maskedNif, resolved: false, ambiguous: false };

  try {
    // Pasar el nombre a Python como argumento (evita inyección SQL)
    const result = execSync(
      `python3 -c "
import duckdb, json, sys
con = duckdb.connect('/var/data/licitaciones/db/licitaciones.duckdb', read_only=True)
name = sys.argv[1]
rows = con.execute('SELECT nif, nombre FROM nif_canonical WHERE UPPER(nombre) = ? LIMIT 10', [name]).fetchall()
if not rows:
    rows = con.execute('SELECT nif, nombre FROM nif_canonical WHERE UPPER(nombre) LIKE ? LIMIT 10', ['%' + name + '%']).fetchall()
print(json.dumps([{'nif': r[0], 'nombre': r[1]} for r in rows]))
" "${normName.replace(/"/g, '\\"')}"`,
      { timeout: 5000, encoding: 'utf-8' }
    );
    const candidates = JSON.parse(result.trim());
    if (candidates.length === 0) return { nif: maskedNif, resolved: false, ambiguous: false };
    return validateNifMatch(maskedNif, candidates);
  } catch (err) {
    // Error silencioso — no romper la ingesta por esto
    return { nif: maskedNif, resolved: false, ambiguous: false };
  }
}

async function resolveMaskedNif(maskedNif, adjudicatarioName) {
  return resolveMaskedNifSync(maskedNif, adjudicatarioName);
}

/**
 * Dado un NIF enmascarado (ej: "****3443*") y una lista de candidatos
 * de nif_canonical, valida cuáles coinciden con el fragmento visible.
 */
function validateNifMatch(maskedNif, candidates) {
  // Limpiar el NIF enmascarado: quitar puntos y espacios
  const cleanMasked = maskedNif.replace(/[^*A-Z0-9]/gi, '').toUpperCase();
  // Filtrar candidatos cuyo NIF coincida con el patrón
  const matches = candidates.filter(c => {
    const cleanCanonical = String(c.nif || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (cleanCanonical.length !== cleanMasked.length) return false;
    for (let i = 0; i < cleanMasked.length; i++) {
      if (cleanMasked[i] !== '*' && cleanMasked[i] !== cleanCanonical[i]) return false;
    }
    return true;
  });

  if (matches.length === 0) {
    // Ningún candidato válido — el nombre coincide pero el NIF no
    return { nif: maskedNif, resolved: false, ambiguous: false, nameMatch: true };
  }
  if (matches.length === 1) {
    return { nif: matches[0].nif, resolved: true, ambiguous: false };
  }
  // Múltiples matches — devolver el primero y marcar ambiguo
  return { nif: matches[0].nif, resolved: true, ambiguous: true };
}

const BOE_API_BASE = 'https://www.boe.es/datosabiertos/api/boe/sumario';
const BOE_XML_BASE = 'https://www.boe.es/diario_boe/xml.php?id=';
const DATA_FILE = path.join(__dirname, '..', 'data', 'boe_contracts.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'boe.log');

// Sin filtro CPV — capturamos TODA la contratación de la sección 5A
const CPV_TARGETS = [];
const CPV_PREFIXES = [];

// Días a cubrir (7 días — ejecuciones cada 4h, margen suficiente)
const DAYS_BACK = 7;

// Pausa entre lotes (ms) — rate limit ~1 req/s
const BATCH_DELAY = 1000;

// Tamaño del lote paralelo
const PARALLEL_BATCH = 3;

// Timeout por request XML (ms)
const XML_TIMEOUT = 10000;

const MAX_RETRIES = 2;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchUrl(url, retries = MAX_RETRIES, accept = 'application/json', timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, {
        headers: {
          'User-Agent': 'ElicitaBot/1.0 (ingesta@elicita.es)',
          'Accept': accept,
        },
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `https://www.boe.es${res.headers.location}`;
          return fetchUrl(redirectUrl, retries, accept, timeoutMs).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} para ${url}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });

      req.on('error', (err) => {
        if (n > 1) {
          sleep(2000).then(() => attempt(n - 1)).catch(reject);
        } else {
          reject(err);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        if (n > 1) {
          sleep(1000).then(() => attempt(n - 1)).catch(reject);
        } else {
          reject(new Error(`Timeout en ${url}`));
        }
      });
    };
    attempt(retries);
  });
}

function getRecentWorkdays(days) {
  const dates = [];
  const d = new Date();
  let found = 0;
  while (found < days) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      dates.push(`${y}${m}${day}`);
      found++;
    }
    d.setDate(d.getDate() - 1);
  }
  return dates;
}

// Sin filtro por keywords — capturamos todo

async function fetchSumarioItems(fecha) {
  const url = `${BOE_API_BASE}/${fecha}`;
  let data;
  try {
    const raw = await fetchUrl(url, MAX_RETRIES, 'application/json', 15000);
    data = JSON.parse(raw);
  } catch (err) {
    log(`  ✗ Sumario ${fecha}: ${err.message}`);
    return [];
  }

  if (data.status?.code !== '200') {
    log(`  ✗ Sumario ${fecha}: status ${data.status?.code}`);
    return [];
  }

  const items = [];
  const diarios = data.data?.sumario?.diario;
  const diariosArr = Array.isArray(diarios) ? diarios : (diarios ? [diarios] : []);

  for (const diario of diariosArr) {
    const secciones = diario.seccion;
    const seccionesArr = Array.isArray(secciones) ? secciones : (secciones ? [secciones] : []);

    for (const seccion of seccionesArr) {
      if (seccion.codigo !== '5A') continue;

      const deps = seccion.departamento;
      const depsArr = Array.isArray(deps) ? deps : (deps ? [deps] : []);

      for (const dep of depsArr) {
        const directItems = dep.item ? (Array.isArray(dep.item) ? dep.item : [dep.item]) : [];
        const epigrafes = dep.epigrafe ? (Array.isArray(dep.epigrafe) ? dep.epigrafe : [dep.epigrafe]) : [];

        let allItems = [...directItems];
        for (const ep of epigrafes) {
          const epItems = ep.item ? (Array.isArray(ep.item) ? ep.item : [ep.item]) : [];
          allItems = allItems.concat(epItems);
        }

        for (const item of allItems) {
          if (!item.identificador) continue;
          items.push({
            identificador: item.identificador,
            titulo: item.titulo || '',
            url_html: item.url_html || `https://www.boe.es/diario_boe/txt.php?id=${item.identificador}`,
            fecha,
          });
        }
      }
    }
  }

  return items;
}

function cleanText(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extraer el texto del siguiente <dd> tras un <dt> que matchea fieldPattern.
function extractField(xml, fieldPattern) {
  if (!xml) return null;
  const flags = (fieldPattern.flags || '').includes('i') ? 'is' : 's';
  const re = new RegExp(
    '<dt>\\s*(?:<[^\u003e]+\u003e\\s*)?' + fieldPattern.source + '(?::\\s*)?(?:\\s*</[^\u003e]+\u003e)?\\s*</dt>\\s*<dd>([\\s\\S]*?)</dd>',
    flags
  );
  const m = xml.match(re);
  return m ? cleanText(m[1]) : null;
}

// Extraer un campo anidado a partir de un <dt> contenedor con sub <dl>.
function extractNestedField(xml, fieldPattern, subField) {
  if (!xml) return null;
  const flags = ((fieldPattern.flags || '').includes('i') || (subField.flags || '').includes('i')) ? 'is' : 's';
  const re = new RegExp(
    '<dt>\\s*(?:<[^\u003e]+\u003e\\s*)?' + fieldPattern.source + '(?::\\s*)?(?:\\s*</[^\u003e]+\u003e)?\\s*</dt>\\s*<dd>\\s*<dl>[\\s\\S]*?<dt>\\s*(?:<[^\u003e]+\u003e\\s*)?' + subField.source + '(?::\\s*)?(?:\\s*</[^\u003e]+\u003e)?\\s*</dt>\\s*<dd>(.*?)</dd>',
    flags
  );
  const m = xml.match(re);
  return m ? cleanText(m[1]) : null;
}

// Parsear importe español: "7.864.767,00 euros" → 7864767.00
function parseSpanishMoney(text) {
  if (!text) return 0;
  const cleaned = text.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}

function parseFecha(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  if (/^\d{8}$/.test(str)) return `${str.slice(0,4)}-${str.slice(4,6)}-${str.slice(6,8)}`;
  return null;
}

// Parsear fecha en texto español: "26 de junio de 2026" → "2026-06-26"
function parseSpanishDate(text) {
  const months = {
    'enero': '01', 'febrero': '02', 'marzo': '03', 'abril': '04',
    'mayo': '05', 'junio': '06', 'julio': '07', 'agosto': '08',
    'septiembre': '09', 'octubre': '10', 'noviembre': '11', 'diciembre': '12'
  };
  const m = text.match(/(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i);
  if (m) {
    const day = m[1].padStart(2, '0');
    const month = months[m[2].toLowerCase()] || '01';
    return `${m[3]}-${month}-${day}`;
  }
  return null;
}

// Extraer CPVs del texto: "72500000 (Servicios informáticos)" → ["72500000"]
function extractCpvsFromText(text) {
  if (!text) return [];
  const matches = text.match(/\b(\d{8})\b/g) || [];
  return [...new Set(matches)];
}

async function fetchAndParseItem(item) {
  const xmlUrl = `${BOE_XML_BASE}${item.identificador}`;
  let xml;
  try {
    xml = await fetchUrl(xmlUrl, 1, 'text/xml', XML_TIMEOUT); // sin reintentos para no bloquear
  } catch (err) {
    log(`    ✗ XML ${item.identificador}: ${err.message}`);
    return null;
  }

  // Metadata <analisis>
  const cpvRaw = (xml.match(/<materias_cpv>([\s\S]*?)<\/materias_cpv>/) || [])[1] || '';
  const modalMatch = xml.match(/<modalidad codigo="([^"]*)">(.*?)<\/modalidad>/);
  const modalidadCodigo = modalMatch ? modalMatch[1] : '';
  const modalidadNombre = modalMatch ? cleanText(modalMatch[2]) : '';

  const tipoMatch = xml.match(/<tipo codigo="([^"]*)">(.*?)<\/tipo>/);
  const tipoContrato = tipoMatch ? cleanText(tipoMatch[2]) : '';

  // CPVs: del texto primero (más completo), fallback a <materias_cpv>
  let cpvFieldCodes = [];
  const cpvText = extractField(xml, /\d+\.\s*C[oó]digos?\s+CPV/i) || cpvRaw;
  if (cpvText) {
    cpvFieldCodes = extractCpvsFromText(cpvText);
  }
  if (cpvFieldCodes.length === 0 && cpvRaw) {
    cpvFieldCodes = extractCpvsFromText(cpvRaw);
  }

  // Organismo: preferir bloque 1.1) Nombre en el XML, fallback a <departamento>
  let organismo = extractField(xml, /1\.1\)\s*Nombre/i);
  if (!organismo) {
    const orgMatch = xml.match(/<departamento[^>]*>(.*?)<\/departamento>/);
    organismo = cleanText(orgMatch ? orgMatch[1] : '');
  }

  // Fecha de publicación
  const fechaPubMatch = xml.match(/<fecha_publicacion>(\d{8})<\/fecha_publicacion>/);
  const fechaPublicacion = fechaPubMatch
    ? parseFecha(fechaPubMatch[1])
    : item.fecha.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');

  // Expediente: del título (después de "Expediente: ")
  let expediente = null;
  const titulo = cleanText(item.titulo || '');
  const expMatch = titulo.match(/\bExpediente:\s*(.+?)(?:\s+\.|\.$|$)/i);
  if (expMatch) {
    expediente = expMatch[1].trim();
  } else {
    // Fallback: buscar en el texto
    const textoXml = xml.match(/<texto>([\s\S]*?)<\/texto>/) || ['', xml];
    const expText = extractField(textoXml[1], /\d+\.?\s*Expediente/i);
    if (expText) expediente = expText;
  }

  // Objeto/descripción
  let objeto = '';
  // Licitaciones: descripción en el cuerpo; formalizaciones: del título.
  if (modalidadCodigo === 'L') {
    const desc = extractField(xml, /7\.\s*Descripci[oó]n\s+de\s+la\s+licitaci[oó]n/i)
      || extractField(xml, /6\.1\)\s*Descripci[oó]n\s+gen[eé]rica/i);
    if (desc) objeto = desc;
  } else if (modalidadCodigo === 'F') {
    const objMatch = titulo.match(/\bObjeto:\s*([^\.]+)/i);
    if (objMatch) objeto = objMatch[1].trim();
  }
  if (!objeto) {
    const desc = extractField(xml, /(?:6|7)\.\s*Descripci[oó]n\s+(?:gen[eé]rica\s+de\s+la\s+licitaci[oó]n|de\s+la\s+licitaci[oó]n|gen[eé]rica)/i);
    if (desc) objeto = desc;
  }

  // Importe licitación (solo licitaciones)
  let importeLicitacion = 0;
  if (modalidadCodigo === 'L') {
    const valorEstimado = extractField(xml, /8\.\s*Valor\s+estimado/i);
    if (valorEstimado) importeLicitacion = parseSpanishMoney(valorEstimado);
  }

  // Importe adjudicación (solo formalizaciones)
  let importeAdjudicacion = 0;
  let adjudicatario = null;
  let nifAdjudicatario = null;
  let fechaAdjudicacion = null;
  let numOfertas = null;

  if (modalidadCodigo === 'F') {
    // Valor de la oferta seleccionada
    const oferta = extractNestedField(xml, /13\.\s*Valor\s+de\s+las\s+ofertas/i, /13\.1\.1\)\s*Valor\s+de\s+la\s+oferta\s+seleccionada/i)
      || extractField(xml, /13\.1\.1\)\s*Valor\s+de\s+la\s+oferta\s+seleccionada/i);
    if (oferta) importeAdjudicacion = parseSpanishMoney(oferta);

    // Adjudicatario (primer lote)
    adjudicatario = extractNestedField(xml, /12\.\s*Adjudicatarios/i, /12\.1\.1\)\s*Nombre/i)
      || extractField(xml, /12\.1\.1\)\s*Nombre/i);

    // NIF adjudicatario
    nifAdjudicatario = extractNestedField(xml, /12\.\s*Adjudicatarios/i, /12\.1\.2\)\s*N[uú]mero\s+de\s+identificaci[oó]n\s+fiscal/i)
      || extractField(xml, /12\.1\.2\)\s*N[uú]mero\s+de\s+identificaci[oó]n\s+fiscal/i);

    // Fecha de adjudicación
    const fa = extractField(xml, /10\.\s*Fecha\s+de\s+adjudicaci[oó]n/i);
    if (fa) fechaAdjudicacion = parseSpanishDate(fa);

    // Número de ofertas (primer lote)
    const ofertasText = extractNestedField(xml, /11\.\s*Ofertas\s+recibidas/i, /11\.1\.1\)\s*N[uú]mero\s+de\s+ofertas\s+recibidas/i)
      || extractField(xml, /11\.1\.1\)\s*N[uú]mero\s+de\s+ofertas\s+recibidas/i);
    if (ofertasText) {
      const n = parseInt(ofertasText.replace(/\D/g, ''), 10);
      numOfertas = isNaN(n) ? null : n;
    }
  }

  // Fecha fin presentación (solo licitaciones)
  let fechaFin = null;
  if (modalidadCodigo === 'L') {
    const plazo = extractField(xml, /19\.\s*Plazo\s+para\s+la\s+recepci[oó]n(?:\s+de\s+ofertas)?(?:\s+o\s+solicitudes\s+de\s+participaci[oó]n)?/i);
    if (plazo) {
      fechaFin = parseSpanishDate(plazo);
      if (!fechaFin) {
        // Formato alternativo dd/mm/aaaa
        const m = plazo.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) fechaFin = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      }
    }
  }

  const cpvsReportados = cpvFieldCodes.length > 0 ? cpvFieldCodes : [];

  // Estado
  let estado = 'abierta';
  if (modalidadCodigo === 'F') estado = 'formalizada';
  else if (modalidadCodigo === 'P') estado = 'preparacion';

  // Resolver NIF enmascarado del BOE usando nif_canonical
  const resolvedNif = await resolveMaskedNif(nifAdjudicatario, adjudicatario);

  return {
    id: `BOE:${item.identificador}`,
    fuente: 'BOE',
    expediente: expediente || null,
    titulo,
    organismo,
    objeto: objeto || titulo,
    cpvs: [...new Set(cpvsReportados)],
    importe_licitacion: importeLicitacion,
    importe_adjudicacion: importeAdjudicacion,
    fecha_publicacion: fechaPublicacion,
    fecha_fin: fechaFin,
    fecha_adjudicacion: fechaAdjudicacion,
    estado,
    url_fuente: item.url_html,
    adjudicatario,
    nif_adjudicatario: resolvedNif.nif,
    _nif_resolved: resolvedNif.resolved,
    _nif_ambiguous: resolvedNif.ambiguous,
    _nif_boe_raw: nifAdjudicatario,
    _tipo_contrato: tipoContrato,
    _modalidad: modalidadNombre || modalidadCodigo,
    _num_ofertas: numOfertas,
    _cpv_boe_raw: cpvRaw || null,
  };
}

async function processChunk(items) {
  const results = await Promise.all(items.map(item => fetchAndParseItem(item)));
  return results.filter(Boolean);
}

async function run() {
  log('=== Inicio ingesta BOE (optimizada) ===');

  const logDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const dataDir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Cargar cache de IDs ya procesados
  let cachedIds = new Set();
  let cachedContratos = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      cachedContratos = existing.contratos || [];
      cachedIds = new Set(cachedContratos.map(c => c.id));
      log(`Cache: ${cachedIds.size} contratos ya procesados`);
    } catch (_) {}
  }

  const workdays = getRecentWorkdays(DAYS_BACK);
  log(`Procesando ${workdays.length} días hábiles (últimos ${DAYS_BACK} días)`);

  const nuevos = [];
  const vistos = new Set();

  for (const fecha of workdays) {
    log(`→ Sumario ${fecha}`);

    const items = await fetchSumarioItems(fecha);
    log(`  5A items: ${items.length}`);

    if (items.length === 0) { await sleep(500); continue; }

    // Sin filtro — capturamos todo de sección 5A (solo skip duplicados y cache)
    const filtrados = items.filter(item => {
      if (vistos.has(item.identificador)) return false;
      if (cachedIds.has(`BOE:${item.identificador}`)) {
        vistos.add(item.identificador);
        return false;
      }
      vistos.add(item.identificador);
      return true;
    });

    log(`  Nuevos a procesar: ${filtrados.length} de ${items.length}`);

    if (filtrados.length === 0) { await sleep(500); continue; }

    // Procesar en lotes de PARALLEL_BATCH
    for (let i = 0; i < filtrados.length; i += PARALLEL_BATCH) {
      const chunk = filtrados.slice(i, i + PARALLEL_BATCH);
      const results = await processChunk(chunk);
      for (const c of results) {
        nuevos.push(c);
        log(`  ✓ ${c.id.replace('BOE:', '')} | CPV: ${c.cpvs.join(',')} | ${c.titulo.slice(0, 60)}`);
      }
      if (i + PARALLEL_BATCH < filtrados.length) {
        await sleep(BATCH_DELAY); // rate limit entre lotes
      }
    }

    await sleep(500);
  }

  log(`Nuevos contratos encontrados: ${nuevos.length}`);

  // Merge: nuevos + cache (los nuevos tienen prioridad por si actualizan un existente)
  // Merge-by-ID con retención inteligente (lib/merge.js)
  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, nuevos, {
    fuente: 'BOE',
    meta: { seccion: 'V.A — Contratación del Sector Público' },
    log,
  });
  log('=== Fin ingesta BOE ===\n');

  return stats;
}

module.exports = { run, fetchAndParseItem, resolveMaskedNif };

if (require.main === module) {
  run().catch(err => {
    log(`ERROR FATAL: ${err.message}`);
    process.exit(1);
  });
}
