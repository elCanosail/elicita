/**
 * profiler.js — Perfilado automático de empresa desde TED EU
 *
 * Dado un nombre y CIF de empresa, busca en TED (Tenders Electronic Daily)
 * todos los Contract Award Notices donde aparece como adjudicataria,
 * extrae el perfil real y detecta competidores reales.
 *
 * API usada: POST https://api.ted.europa.eu/v3/notices/search
 *
 * Campos TED utilizados:
 *   - winner-name          : nombre del adjudicatario (búsqueda por texto)
 *   - winner-identifier    : CIF/NIF del adjudicatario (para filtrar por empresa exacta)
 *   - winner-country       : país del adjudicatario
 *   - organisation-name-buyer : organismo comprador
 *   - classification-cpv   : códigos CPV del contrato
 *   - total-value          : valor total adjudicado
 *   - title-lot            : título del lote/contrato
 *   - publication-date     : fecha de publicación de la adjudicación
 *   - notice-subtype       : subtipo (29 = Contract Award Notice estándar)
 *   - publication-number   : identificador único del aviso en TED
 *
 * REGLA: Jamás datos inventados. Solo datos reales de TED.
 * Las proyecciones están etiquetadas como [PROYECCIÓN].
 *
 * Node.js nativo (https) — sin dependencias externas.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const TED_API_HOST = 'api.ted.europa.eu';
const TED_API_PATH = '/v3/notices/search';
const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'profiler.log');
const OUTPUT_FILE = path.join(DATA_DIR, 'client_profile.json');

// ─── Logging ───────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

// ─── HTTP helper (nativo) ──────────────────────────────────────────────────

function tedPost(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: TED_API_HOST,
      port: 443,
      path: TED_API_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message} — body: ${data.slice(0, 200)}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Extracción de texto multiidioma (mismo patrón que ted.js) ────────────

function extractText(val, langs = ['spa', 'eng']) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    for (const lang of langs) {
      const found = val.find(i => {
        const l = i?.['@language']?.toLowerCase() || i?.['@xml:lang']?.toLowerCase();
        return l === lang || l?.startsWith(lang);
      });
      if (found) return extractText(found, langs);
    }
    return extractText(val[0], langs);
  }
  if (typeof val === 'object') {
    if (val['#text']) return val['#text'];
    for (const lang of langs) {
      if (val[lang]) {
        const v = val[lang];
        if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : extractText(v[0], langs);
        return String(v);
      }
    }
    // Tomar primera clave disponible
    const firstKey = Object.keys(val)[0];
    if (firstKey) return extractText(val[firstKey], langs);
  }
  return String(val);
}

function extractAllTexts(val, langs = ['spa', 'eng']) {
  if (!val) return [];
  if (typeof val === 'object' && !Array.isArray(val)) {
    // Objeto multiidioma {spa: [...], eng: [...]}
    const results = [];
    for (const lang of langs) {
      if (val[lang]) {
        const v = val[lang];
        const items = Array.isArray(v) ? v : [v];
        items.forEach(i => {
          const t = typeof i === 'string' ? i : extractText(i, langs);
          if (t && !results.includes(t)) results.push(t);
        });
      }
    }
    if (results.length) return results;
    // Fallback: todas las claves
    return Object.values(val).flat().map(i => typeof i === 'string' ? i : extractText(i, langs));
  }
  if (Array.isArray(val)) return val.map(i => typeof i === 'string' ? i : extractText(i, langs)).filter(Boolean);
  return [String(val)];
}

// ─── Búsqueda paginada de adjudicaciones ──────────────────────────────────

const AWARD_FIELDS = [
  'publication-number',
  'notice-subtype',
  'winner-name',
  'winner-identifier',
  'winner-country',
  'organisation-name-buyer',
  'classification-cpv',
  'total-value',
  'title-lot',
  'publication-date',
  'links',
];

/**
 * Busca todos los Contract Award Notices donde aparece el término de búsqueda
 * como winner en España. Pagina automáticamente.
 */
async function searchAwardNotices(searchTerm, maxPages = 10) {
  log(`Buscando adjudicaciones TED para: "${searchTerm}"`);
  const allNotices = [];
  let page = 1;
  let total = null;

  while (page <= maxPages) {
    const body = {
      // Buscar por winner-name + país comprador España
      // notice-subtype=29 son Contract Award Notices (CAN) en formato eForms
      // También hay CANs en formato anterior (subtipo diferente), no filtramos subtype para capturar todos
      query: `winner-name="${searchTerm}" AND organisation-country-buyer=ESP`,
      fields: AWARD_FIELDS,
      limit: 50,
      page: page,
    };

    try {
      const data = await tedPost(body);
      const notices = data.notices || [];
      if (total === null) {
        total = data.totalNoticeCount || 0;
        log(`  Total avisos TED encontrados: ${total}`);
      }

      if (notices.length === 0) break;
      allNotices.push(...notices);
      log(`  Página ${page}: ${notices.length} avisos (acumulado: ${allNotices.length}/${total})`);

      if (allNotices.length >= total) break;
      page++;
      await sleep(800);
    } catch (err) {
      log(`  ERROR página ${page}: ${err.message}`);
      break;
    }
  }

  return allNotices;
}

// ─── Filtrado por CIF ──────────────────────────────────────────────────────

/**
 * Filtra los avisos donde el CIF de la empresa aparece en winner-identifier.
 * Esto garantiza que solo contamos contratos donde SÍ ganó la empresa exacta.
 */
function filterByCIF(notices, cif) {
  if (!cif) return notices; // Sin CIF, devolver todos

  const cifNorm = cif.toUpperCase().trim();
  return notices.filter(n => {
    const ids = n['winner-identifier'] || [];
    const idsArr = Array.isArray(ids) ? ids : [ids];
    return idsArr.some(id => String(id).toUpperCase().trim() === cifNorm);
  });
}

// ─── Normalización de aviso a adjudicación ────────────────────────────────

function normalizeAdjudicacion(n) {
  const pubNum = n['publication-number'] || '';
  const cpvs = Array.isArray(n['classification-cpv'])
    ? [...new Set(n['classification-cpv'])]
    : (n['classification-cpv'] ? [n['classification-cpv']] : []);

  const buyers = extractAllTexts(n['organisation-name-buyer']);
  const organismo = buyers[0] || 'Desconocido';

  const titles = extractAllTexts(n['title-lot']);
  const titulo = titles[0] || 'Sin título';

  // Normalizar fecha: quitar zona horaria y dejar solo YYYY-MM-DD
  const rawDate = n['publication-date'] || '';
  const fechaPub = rawDate.split('T')[0].replace(/[Z+].*$/, '').trim();
  const importe = parseFloat(n['total-value']) || 0;

  const url = n['links']?.html?.SPA
    || `https://ted.europa.eu/es/notice/-/detail/${pubNum}`;

  return {
    id: `TED:${pubNum}`,
    expediente: pubNum,
    titulo,
    organismo,
    cpvs,
    importe_adjudicado: importe,
    moneda: 'EUR',
    fecha_publicacion: fechaPub,
    url_fuente: url,
    notice_subtype: n['notice-subtype'] || '',
  };
}

// ─── Análisis de perfil ────────────────────────────────────────────────────

function buildProfile(empresa, cif, adjudicaciones) {
  // 1. CPVs activos (frecuencia)
  const cpvCount = {};
  adjudicaciones.forEach(a => {
    a.cpvs.forEach(cpv => {
      cpvCount[cpv] = (cpvCount[cpv] || 0) + 1;
    });
  });
  const cpvsActivos = Object.entries(cpvCount)
    .sort((a, b) => b[1] - a[1])
    .map(([cpv, count]) => ({ cpv, contratos: count }));

  // 2. Organismos recurrentes
  const orgMap = {};
  adjudicaciones.forEach(a => {
    const k = a.organismo;
    if (!orgMap[k]) orgMap[k] = { nombre: k, contratos: 0, fechas: [], importe_total: 0 };
    orgMap[k].contratos++;
    orgMap[k].fechas.push(a.fecha_publicacion);
    orgMap[k].importe_total += a.importe_adjudicado;
  });

  const organismosFrecuentes = Object.values(orgMap)
    .sort((a, b) => b.contratos - a.contratos)
    .slice(0, 20)
    .map(o => {
      const fechasOrdenadas = o.fechas.filter(Boolean).sort();
      return {
        nombre: o.nombre,
        contratos: o.contratos,
        primero: fechasOrdenadas[0] || null,
        ultimo: fechasOrdenadas[fechasOrdenadas.length - 1] || null,
        importe_total: Math.round(o.importe_total),
      };
    });

  // 3. Importes medios por CPV
  // Nota: el importe total se atribuye al contrato, no a cada CPV individual.
  // Para evitar inflación, contamos cada contrato una vez por CPV único.
  const cpvImporte = {};
  adjudicaciones.forEach(a => {
    if (a.importe_adjudicado > 0) {
      const cpvsUnicos = [...new Set(a.cpvs)];
      // Distribuir el importe equitativamente entre CPVs del contrato
      const importePorCpv = a.importe_adjudicado / cpvsUnicos.length;
      cpvsUnicos.forEach(cpv => {
        if (!cpvImporte[cpv]) cpvImporte[cpv] = { suma: 0, count: 0 };
        cpvImporte[cpv].suma += importePorCpv;
        cpvImporte[cpv].count++;
      });
    }
  });

  const cpvsConImporte = cpvsActivos.map(({ cpv, contratos }) => {
    const imp = cpvImporte[cpv];
    return {
      cpv,
      contratos,
      importe_medio: imp ? Math.round(imp.suma / imp.count) : null,
      importe_total: imp ? Math.round(imp.suma) : null,
    };
  });

  // 4. Ciclos de renovación [PROYECCIÓN basada en datos reales]
  // Detectar pares (organismo + CPV) con >1 contrato y calcular intervalos
  const cicloMap = {};
  adjudicaciones.forEach(a => {
    if (!a.fecha_publicacion) return; // Saltarse sin fecha
    [...new Set(a.cpvs)].forEach(cpv => {
      const key = `${a.organismo}|||${cpv}`;
      if (!cicloMap[key]) cicloMap[key] = { organismo: a.organismo, cpv, fechas: [] };
      cicloMap[key].fechas.push(a.fecha_publicacion);
    });
  });

  const ciclosRenovacion = Object.values(cicloMap)
    .filter(c => c.fechas.length >= 2)
    .map(c => {
      // Ordenar y convertir a objetos Date válidos
      const fechasOrdenadas = c.fechas
        .map(f => f.replace('Z', '').split('T')[0]) // "2023-11-30"
        .sort();

      const fechaObjs = fechasOrdenadas.map(f => new Date(f));
      if (fechaObjs.some(d => isNaN(d.getTime()))) return null; // Fechas inválidas

      const intervalos = [];
      for (let i = 1; i < fechaObjs.length; i++) {
        const diffMs = fechaObjs[i].getTime() - fechaObjs[i - 1].getTime();
        const diffMeses = diffMs / (1000 * 60 * 60 * 24 * 30.44);
        if (diffMeses > 0) intervalos.push(diffMeses);
      }
      if (intervalos.length === 0) return null;

      const intervaloMedio = Math.round(intervalos.reduce((a, b) => a + b, 0) / intervalos.length);
      const ultimaFecha = fechaObjs[fechaObjs.length - 1];
      const proximaFecha = new Date(ultimaFecha);
      proximaFecha.setMonth(proximaFecha.getMonth() + intervaloMedio);

      const proximoAño = proximaFecha.getFullYear();
      const proximoTrimestre = Math.ceil((proximaFecha.getMonth() + 1) / 3);

      return {
        organismo: c.organismo,
        cpv: c.cpv,
        contratos_detectados: c.fechas.length,
        intervalo_meses: intervaloMedio,
        ultimo_contrato: fechasOrdenadas[fechasOrdenadas.length - 1],
        proximo_estimado: `[PROYECCIÓN] ${proximoAño}-Q${proximoTrimestre}`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.contratos_detectados - a.contratos_detectados)
    .slice(0, 10);

  return {
    cpvs_activos: cpvsConImporte,
    organismos_recurrentes: organismosFrecuentes,
    ciclos_renovacion: ciclosRenovacion,
  };
}

// ─── Detección de competidores reales ─────────────────────────────────────

/**
 * Busca otros adjudicatarios en los mismos CPVs + España.
 * Esto da competidores REALES detectados en TED, no inventados.
 */
async function detectarCompetidores(cpvsActivos, empresaNombre, cif, maxCpvs = 5) {
  log(`Buscando competidores reales en TED para CPVs top...`);

  // Tomar los CPVs más frecuentes
  const cpvsTop = cpvsActivos.slice(0, maxCpvs).map(c => c.cpv);

  const competidorMap = {};

  for (const cpv of cpvsTop) {
    log(`  CPV ${cpv}: buscando otros adjudicatarios...`);
    try {
      const body = {
        // Buscar adjudicaciones en este CPV en España, excluyendo la propia empresa
        query: `classification-cpv=${cpv} AND organisation-country-buyer=ESP AND winner-country=ESP`,
        fields: ['publication-number', 'winner-name', 'winner-identifier', 'classification-cpv', 'publication-date'],
        limit: 50,
        page: 1,
      };

      const data = await tedPost(body);
      const notices = data.notices || [];
      log(`    → ${notices.length} avisos (total: ${data.totalNoticeCount || '?'})`);

      notices.forEach(n => {
        const winnerNames = extractAllTexts(n['winner-name']);
        const winnerIds = Array.isArray(n['winner-identifier'])
          ? n['winner-identifier']
          : (n['winner-identifier'] ? [n['winner-identifier']] : []);
        const cpvs = Array.isArray(n['classification-cpv']) ? n['classification-cpv'] : [];

        winnerNames.forEach((nombre, idx) => {
          // Excluir la propia empresa (por CIF o por nombre similar)
          const idForThisWinner = winnerIds[idx] || '';
          if (cif && idForThisWinner.toUpperCase() === cif.toUpperCase()) return;
          if (nombre.toUpperCase().includes(empresaNombre.toUpperCase().split(' ')[0])) return;

          const key = nombre.trim().toUpperCase();
          if (!competidorMap[key]) {
            competidorMap[key] = {
              nombre: nombre.trim(),
              cif: idForThisWinner || null,
              cpvs_comunes: new Set(),
              adjudicaciones: 0,
              ultima_adjudicacion: null,
            };
          }
          competidorMap[key].adjudicaciones++;
          cpvs.forEach(c => competidorMap[key].cpvs_comunes.add(c));
          const fecha = (n['publication-date'] || '').replace('Z', '');
          if (fecha && (!competidorMap[key].ultima_adjudicacion || fecha > competidorMap[key].ultima_adjudicacion)) {
            competidorMap[key].ultima_adjudicacion = fecha;
          }
        });
      });

      await sleep(600);
    } catch (err) {
      log(`  ERROR CPV ${cpv}: ${err.message}`);
    }
  }

  // Convertir a array y serializar Sets
  return Object.values(competidorMap)
    .map(c => ({
      nombre: c.nombre,
      cif: c.cif,
      cpvs_comunes: [...c.cpvs_comunes].filter(cpv => cpvsTop.includes(cpv)),
      adjudicaciones: c.adjudicaciones,
      ultima_adjudicacion: c.ultima_adjudicacion,
    }))
    .filter(c => c.cpvs_comunes.length > 0)
    .sort((a, b) => b.adjudicaciones - a.adjudicaciones)
    .slice(0, 20);
}

// ─── Función principal ─────────────────────────────────────────────────────

async function profileEmpresa({ empresa, cif }) {
  log(`\n${'='.repeat(60)}`);
  log(`INICIO PERFILADO: ${empresa} (${cif})`);
  log(`${'='.repeat(60)}`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // 1. Buscar todos los Contract Award Notices donde aparece como winner
  // Usamos el nombre corto para mayor cobertura, luego filtramos por CIF
  const searchTerm = empresa.split(' ')[0]; // e.g. "Applus"
  log(`\n[1/4] Buscando adjudicaciones en TED...`);
  const allNotices = await searchAwardNotices(searchTerm, 10);
  log(`  Avisos encontrados (sin filtrar): ${allNotices.length}`);

  // 2. Filtrar solo los que incluyen el CIF exacto
  const noticesFiltrados = filterByCIF(allNotices, cif);
  log(`  Avisos donde aparece CIF ${cif}: ${noticesFiltrados.length}`);

  // Si no hay resultados por CIF, usar todos (puede que el CIF no esté disponible)
  const noticesToUse = noticesFiltrados.length > 0 ? noticesFiltrados : allNotices;
  if (noticesFiltrados.length === 0) {
    log(`  ⚠️  Sin resultados por CIF. Usando todos (${allNotices.length}) — pueden incluir empresas del grupo.`);
  }

  // 3. Normalizar a adjudicaciones
  const adjudicaciones = noticesToUse.map(normalizeAdjudicacion).filter(Boolean);
  log(`\n[2/4] Adjudicaciones normalizadas: ${adjudicaciones.length}`);

  // 4. Construir perfil
  log(`\n[3/4] Construyendo perfil...`);
  const perfil = buildProfile(empresa, cif, adjudicaciones);
  log(`  CPVs únicos detectados: ${perfil.cpvs_activos.length}`);
  log(`  Organismos únicos: ${perfil.organismos_recurrentes.length}`);
  log(`  Ciclos renovación detectados: ${perfil.ciclos_renovacion.length}`);

  // 5. Detectar competidores reales
  log(`\n[4/4] Detectando competidores reales en TED...`);
  const competidores = await detectarCompetidores(
    perfil.cpvs_activos,
    searchTerm,
    cif,
    5
  );
  log(`  Competidores reales encontrados: ${competidores.length}`);

  // 6. Montar perfil final
  const profile = {
    empresa,
    cif,
    generado: new Date().toISOString(),
    fuente: 'TED EU (api.ted.europa.eu/v3/notices/search)',
    metodologia: [
      'Búsqueda por winner-name en Contract Award Notices (ESP)',
      'Filtrado por winner-identifier (CIF)',
      'Análisis de CPVs, organismos e importes de adjudicaciones reales',
      'Detección de competidores por CPVs comunes en TED',
    ],
    total_adjudicaciones: adjudicaciones.length,
    adjudicaciones: adjudicaciones.map(a => ({
      id: a.id,
      expediente: a.expediente,
      titulo: a.titulo,
      organismo: a.organismo,
      cpvs: a.cpvs,
      importe_adjudicado: a.importe_adjudicado,
      moneda: a.moneda,
      fecha_publicacion: a.fecha_publicacion,
      url_fuente: a.url_fuente,
    })),
    cpvs_activos: perfil.cpvs_activos,
    organismos_recurrentes: perfil.organismos_recurrentes,
    competidores,
    ciclos_renovacion: perfil.ciclos_renovacion,
    notas: noticesFiltrados.length === 0
      ? ['Sin coincidencias exactas de CIF — resultados incluyen otras empresas del grupo Applus']
      : [],
  };

  // 7. Guardar
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(profile, null, 2));
  log(`\n✅ Perfil guardado en: ${OUTPUT_FILE}`);
  log(`   - ${adjudicaciones.length} adjudicaciones reales`);
  log(`   - ${perfil.cpvs_activos.length} CPVs activos`);
  log(`   - ${perfil.organismos_recurrentes.length} organismos`);
  log(`   - ${competidores.length} competidores detectados`);
  log(`   - ${perfil.ciclos_renovacion.length} ciclos de renovación estimados`);
  log(`${'='.repeat(60)}\n`);

  return profile;
}

// ─── CLI directo ───────────────────────────────────────────────────────────

if (require.main === module) {
  profileEmpresa({
    empresa: 'Applus Norcontrol SL',
    cif: 'B15044357',
  }).catch(err => {
    log(`ERROR FATAL: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { profileEmpresa };
