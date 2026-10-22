/**
 * Conector PLACSP — Datos Abiertos de Licitaciones
 * Fuente: https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/
 *
 * Estrategia: ZIPs mensuales con ATOM XML (acceso público sin certificado)
 * URL patrón: licitacionesPerfilesContratanteCompleto3_AAAAMM.zip
 *
 * Flujo:
 *   1. Calcular mes actual + mes anterior (AAAAMM)
 *   2. Descargar ZIPs
 *   3. Extraer ATOM XML en memoria (adm-zip)
 *   4. Parsear XML (xml2js) → arrays de entries
 *   5. Deduplicar por expediente (más reciente gana)
 *   6. Guardar TODOS los contratos en data/placsp_contracts.json
 */

'use strict';

const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const AdmZip = require('adm-zip');
const { parseStringPromise } = require('xml2js');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────

const BASE_URL = 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643';
const ZIP_PATTERN = 'licitacionesPerfilesContratanteCompleto3_AAAAMM.zip';

const PROJECT_DIR = path.join(__dirname, '..');
const DATA_FILE   = path.join(PROJECT_DIR, 'data', 'placsp_contracts.json');
const LOG_FILE    = path.join(PROJECT_DIR, 'logs', 'placsp.log');

// Asegurar directorios
[path.dirname(DATA_FILE), path.dirname(LOG_FILE)].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Mapeo de estados ──────────────────────────────────────────────────────

const ESTADO_MAP = {
  PUB: 'abierta',
  EV:  'evaluacion',
  ADJ: 'adjudicada',
  RES: 'resuelta',
  PRE: 'anuncio_previo',
  ANU: 'anulada',
};

// ── Logging ───────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Devuelve 'AAAAMM' para un offset de meses respecto al actual.
 * offset=0 → mes actual, offset=-1 → mes anterior
 */
function mesAAAAMM(offset = 0) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const year  = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

/**
 * Descarga una URL y devuelve el buffer completo.
 */
async function descargar(url) {
  log(`Descargando: ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Elicita/1.0 (datos abiertos PLACSP)' },
    timeout: 120000,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} para ${url}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Extrae el primer fichero .atom o .xml del ZIP buffer.
 * Devuelve array de { nombre, contenido } para cada fichero XML/ATOM.
 */
function extraerFicherosXML(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const result = [];
  for (const entry of entries) {
    const name = entry.entryName.toLowerCase();
    if (!entry.isDirectory && (name.endsWith('.atom') || name.endsWith('.xml'))) {
      const contenido = entry.getData().toString('utf8');
      result.push({ nombre: entry.entryName, contenido });
    }
  }
  return result;
}

/**
 * Extrae texto de un nodo xml2js (puede ser string, array o { _ }).
 */
function txt(node) {
  if (!node) return null;
  if (Array.isArray(node)) return txt(node[0]);
  if (typeof node === 'string') return node.trim() || null;
  if (node._) return node._.trim() || null;
  if (typeof node === 'object') {
    // objeto con texto directo
    const keys = Object.keys(node);
    if (keys.length === 1) return txt(node[keys[0]]);
  }
  return null;
}

/**
 * Extrae atributo de un nodo xml2js.
 */
function attr(node, attrName) {
  if (!node) return null;
  const n = Array.isArray(node) ? node[0] : node;
  if (n && n.$ && n.$[attrName]) return n.$[attrName];
  return null;
}

/**
 * Busca recursivamente todos los nodos con una clave dada en un objeto.
 * Devuelve array de nodos encontrados.
 */
function findAll(obj, key) {
  if (!obj || typeof obj !== 'object') return [];
  const results = [];
  if (Array.isArray(obj)) {
    for (const item of obj) results.push(...findAll(item, key));
  } else {
    if (obj[key] !== undefined) {
      const v = obj[key];
      results.push(...(Array.isArray(v) ? v : [v]));
    }
    for (const k of Object.keys(obj)) {
      if (k !== key) results.push(...findAll(obj[k], key));
    }
  }
  return results;
}

// ── Parseo de una entry ATOM ──────────────────────────────────────────────

/**
 * Parsea una <entry> del ATOM y devuelve el objeto contrato normalizado.
 * Retorna null si no tiene datos mínimos.
 */
function parsearEntry(entry) {
  try {
    // Título
    const titulo = txt(entry['title'] || entry['atom:title']);

    // URL ficha
    let urlFuente = null;
    const links = entry['link'] || entry['atom:link'] || [];
    const linksArr = Array.isArray(links) ? links : [links];
    for (const lk of linksArr) {
      const rel  = attr(lk, 'rel') || 'alternate';
      const href = attr(lk, 'href');
      if (href && rel === 'alternate') { urlFuente = href; break; }
    }
    if (!urlFuente) {
      // Cualquier link con href
      for (const lk of linksArr) {
        const href = attr(lk, 'href');
        if (href && !href.endsWith('.atom') && !href.endsWith('.xml')) {
          urlFuente = href; break;
        }
      }
    }

    // Fecha actualización (atom:updated)
    const fechaActualizacion = txt(entry['updated'] || entry['atom:updated']);

    // Expediente (ContractFolderID)
    const expedientesRaw = findAll(entry, 'cbc:ContractFolderID')
      .concat(findAll(entry, 'ContractFolderID'));
    const expediente = txt(expedientesRaw[0]) || null;

    // Estado (ContractFolderStatusCode)
    const estadosRaw = findAll(entry, 'cbc-place-ext:ContractFolderStatusCode')
      .concat(findAll(entry, 'ContractFolderStatusCode'));
    const estadoCodigo = txt(estadosRaw[0]) || null;
    const estado = ESTADO_MAP[estadoCodigo] || estadoCodigo || 'desconocido';

    // CPVs (ItemClassificationCode — puede haber varios)
    const cpvsRaw = findAll(entry, 'cbc:ItemClassificationCode')
      .concat(findAll(entry, 'ItemClassificationCode'));
    const cpvs = [...new Set(
      cpvsRaw
        .map(n => txt(n))
        .filter(Boolean)
        .map(c => c.replace(/\.0$/, '').trim())
        .filter(c => /^\d{8}(-\d)?$/.test(c) || /^\d{5,8}$/.test(c))
    )];

    // Importe (TotalAmount)
    const importesRaw = findAll(entry, 'cbc:TotalAmount')
      .concat(findAll(entry, 'TotalAmount'));
    let importeLicitacion = null;
    for (const n of importesRaw) {
      const v = parseFloat(txt(n));
      if (!isNaN(v) && v >= 0) { importeLicitacion = v; break; }
    }

    // Organismo (PartyName > Name)
    const partiesRaw = findAll(entry, 'cac:PartyName')
      .concat(findAll(entry, 'PartyName'));
    let organismo = null;
    for (const party of partiesRaw) {
      const name = txt(findAll(party, 'cbc:Name').concat(findAll(party, 'Name'))[0]);
      if (name) { organismo = name; break; }
    }

    // NIF organismo
    const nifRaw = findAll(entry, 'cbc:ID');
    let nifOrganismo = null;
    for (const n of nifRaw) {
      if (attr(n, 'schemeName') === 'NIF') {
        nifOrganismo = txt(n);
        break;
      }
    }

    // ID único
    const id = `PLACSP:${expediente || urlFuente || titulo?.substring(0, 30)}:${organismo || ''}`;

    if (!titulo && !expediente) return null;

    return {
      id,
      fuente: 'PLACSP',
      expediente,
      titulo,
      organismo,
      nif_organismo: nifOrganismo,
      cpvs,
      importe_licitacion: importeLicitacion,
      fecha_publicacion: fechaActualizacion || null,
      fecha_fin_presentacion: null,   // no disponible en ATOM completo
      estado,
      estado_codigo: estadoCodigo,
      url_fuente: urlFuente,
      _updated: fechaActualizacion,   // para deduplicación
    };
  } catch (err) {
    log(`  ⚠️  Error parseando entry: ${err.message}`);
    return null;
  }
}

// ── Parseo de ATOM XML ────────────────────────────────────────────────────

/**
 * Parsea el XML ATOM completo y devuelve array de contratos.
 */
async function parsearATOM(xmlStr, nombreFichero) {
  const parsed = await parseStringPromise(xmlStr, {
    explicitArray: true,
    mergeAttrs: false,
    xmlns: false,
    tagNameProcessors: [],
    attrNameProcessors: [],
  });

  // Navegar hasta las entries
  let root = parsed;
  // El root puede ser 'feed' o 'atom:feed' o similar
  const rootKey = Object.keys(parsed)[0];
  const feed = parsed[rootKey];

  const entriesRaw = feed['entry'] || feed['atom:entry'] || [];
  const entries = Array.isArray(entriesRaw) ? entriesRaw : [entriesRaw];

  log(`  ${nombreFichero}: ${entries.length} entries encontradas`);

  const contratos = [];
  for (const entry of entries) {
    const contrato = parsearEntry(entry);
    if (contrato) contratos.push(contrato);
  }

  log(`  ${nombreFichero}: ${contratos.length} contratos parseados`);
  return contratos;
}

// ── Descarga y proceso de un mes ─────────────────────────────────────────

/**
 * Descarga el ZIP de un mes dado (AAAAMM), lo descomprime y parsea.
 * Devuelve array de contratos.
 */
async function procesarMes(aaaamm) {
  const zipName = ZIP_PATTERN.replace('AAAAMM', aaaamm);
  const url = `${BASE_URL}/${zipName}`;

  let zipBuffer;
  try {
    zipBuffer = await descargar(url);
    log(`  ZIP descargado: ${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    log(`  ❌ No se pudo descargar ${aaaamm}: ${err.message}`);
    return [];
  }

  // Extraer ficheros XML/ATOM del ZIP
  let ficheros;
  try {
    ficheros = extraerFicherosXML(zipBuffer);
    log(`  Ficheros XML en ZIP: ${ficheros.map(f => f.nombre).join(', ')}`);
  } catch (err) {
    log(`  ❌ Error descomprimiendo ZIP de ${aaaamm}: ${err.message}`);
    return [];
  }

  if (ficheros.length === 0) {
    log(`  ⚠️  ZIP de ${aaaamm} sin ficheros XML`);
    return [];
  }

  // Parsear cada fichero (normalmente solo 1 en ZIPs mensuales)
  const contratos = [];
  for (const { nombre, contenido } of ficheros) {
    try {
      const lote = await parsearATOM(contenido, nombre);
      contratos.push(...lote);
    } catch (err) {
      log(`  ❌ Error parseando ${nombre}: ${err.message}`);
    }
  }

  return contratos;
}

// ── Deduplicación ─────────────────────────────────────────────────────────

/**
 * Deduplica contratos por expediente.
 * Si un expediente aparece varias veces, se queda con el más reciente (_updated).
 * Contratos sin expediente se incluyen todos (deduplicados por id).
 */
function deduplicar(contratos) {
  const porExpediente = new Map(); // expediente+organismo → contrato
  const sinExpediente = new Map(); // id → contrato

  for (const c of contratos) {
    if (c.expediente) {
      const clave = `${c.expediente}||${c.organismo || ''}`;
      if (!porExpediente.has(clave)) {
        porExpediente.set(clave, c);
      } else {
        const existing = porExpediente.get(clave);
        // Prioridad de estado: Resuelta > Adjudicada > resto
        const prioridad = (estado) => {
          const map = { resuelta: 1, formalizada: 2, adjudicada: 3, 'adjudicada provisional': 4, 'en evaluación': 5, abierta: 6, publicado: 6 };
          return map[(estado || '').toLowerCase()] || 99;
        };
        // Quedarse con: estado más avanzado, o si es el mismo estado, más reciente
        const priNew = prioridad(c.estado);
        const priOld = prioridad(existing.estado);
        if (priNew < priOld) {
          porExpediente.set(clave, c);
        } else if (priNew === priOld) {
          const fechaNew = c._updated ? new Date(c._updated).getTime() : 0;
          const fechaOld = existing._updated ? new Date(existing._updated).getTime() : 0;
          if (fechaNew > fechaOld) {
            porExpediente.set(clave, c);
          }
        }
      }
    } else {
      sinExpediente.set(c.id, c);
    }
  }

  const result = [...porExpediente.values(), ...sinExpediente.values()];
  // Limpiar campo interno _updated
  for (const c of result) delete c._updated;
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  log('═══════════════════════════════════════════════════');
  log('PLACSP Connector — Datos Abiertos (ATOM/ZIP)');
  log('═══════════════════════════════════════════════════');

  // Meses a descargar: solo mes actual (meses anteriores pesan >100MB y xml2js no escala)
  // TODO: implementar SAX streaming para meses anteriores
  const meses = [mesAAAAMM(0)];
  log(`Meses a descargar: ${meses.join(', ')}`);

  // Descargar y parsear cada mes
  const todosContratos = [];
  for (const mes of meses) {
    log(`\n── Procesando mes ${mes} ──`);
    const contratos = await procesarMes(mes);
    log(`  Contratos obtenidos de ${mes}: ${contratos.length}`);
    todosContratos.push(...contratos);
  }

  log(`\nTotal bruto (con posibles duplicados): ${todosContratos.length}`);

  // Deduplicar
  const contratos = deduplicar(todosContratos);
  log(`Total tras deduplicación: ${contratos.length}`);

  // Estadísticas
  const porEstado = {};
  let conCPV = 0;
  for (const c of contratos) {
    porEstado[c.estado] = (porEstado[c.estado] || 0) + 1;
    if (c.cpvs && c.cpvs.length > 0) conCPV++;
  }

  log('\n── Estadísticas ──');
  log(`Total contratos: ${contratos.length}`);
  log(`Con CPV: ${conCPV} (${((conCPV / contratos.length) * 100).toFixed(1)}%)`);
  log('Por estado:');
  for (const [est, n] of Object.entries(porEstado).sort((a, b) => b[1] - a[1])) {
    log(`  ${est}: ${n}`);
  }

  // Guardar (merge-by-ID: acumula contratos, no sobreescribe)
  const { mergeAndWrite } = require('../lib/merge');
  const stats = mergeAndWrite(DATA_FILE, contratos, {
    fuente: 'PLACSP',
    meta: { meses_descargados: meses },
    log,
  });

  log(`\n✅ Guardado: ${DATA_FILE}`);
  return { total: stats.total };
}

// Export para scheduler
module.exports = { run: main };

// Ejecución directa
if (require.main === module) {
  main().catch(err => {
    log(`❌ Error fatal: ${err.message}`);
    log(err.stack);
    process.exit(1);
  });
}
