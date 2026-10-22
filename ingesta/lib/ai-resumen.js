/**
 * Cliente IA para resúmenes de licitaciones — usado por el scheduler.
 * Genera resúmenes en batch y los guarda en DuckDB (tabla ia_resumenes).
 */
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Proveedor IA: NaN Builders (OpenAI-compatible). Key en /root/.nan_api_key,
// fuera de git y del env de PM2. Solo IA_*/NAN_API_KEY como overrides; los
// OLLAMA_* del .env legacy se ignoran deliberadamente.
const IA_BASE_URL = process.env.IA_BASE_URL || 'https://api.nan.builders/v1';

const IA_API_KEY = (() => {
  if (process.env.NAN_API_KEY || process.env.IA_API_KEY) {
    return process.env.NAN_API_KEY || process.env.IA_API_KEY;
  }
  try {
    return require('fs').readFileSync('/root/.nan_api_key', 'utf8').trim();
  } catch {
    return '';
  }
})();

const PRIMARY_MODEL = process.env.AI_RESUMEN_MODEL_PRIMARY || 'deepseek-v4-flash';
const FALLBACK_MODEL = process.env.AI_RESUMEN_MODEL_FALLBACK || 'gemma4';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESUMEN_CHARS = 150;

function log(msg) {
  const line = `[${new Date().toISOString()}] [ai-resumen] ${msg}`;
  console.log(line);
}

function cleanJsonBlock(raw) {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  }
  s = s.replace(/,\s*(?=[}\]])/g, '');
  return s;
}

function parseResumen(raw) {
  const cleaned = cleanJsonBlock(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') return null;

    const resumen = String(parsed.resumen || parsed.resumen_corto || '').slice(0, MAX_RESUMEN_CHARS);
    const sector = String(parsed.sector || 'otros');
    const tipo = String(parsed.tipo || 'servicio');
    const importeRaw = parsed.importe_estimado ?? parsed.importe_detectado ?? null;
    const importe_detectado = importeRaw === null || importeRaw === undefined || importeRaw === ''
      ? null
      : Number(importeRaw);
    const estado_detectado = String(parsed.plazo_o_estado || parsed.estado_detectado || '');

    if (!resumen) return null;

    return {
      resumen,
      sector,
      tipo,
      importe_detectado: Number.isFinite(importe_detectado) ? importe_detectado : null,
      estado_detectado,
    };
  } catch {
    return null;
  }
}

async function callOllama(model, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${IA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${IA_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: model.startsWith('gemma') ? 0.6 : 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`IA ${model} error ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content
      || data?.message?.content
      || data?.response
      || '';
    return String(content).trim();
  } catch (err) {
    log(`IA ${model} exception: ${err.name}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateResumen(contrato) {
  const objeto = String(contrato.objeto || '');
  const organismo = String(contrato.organismo || '');
  const importe = contrato.importe_licitacion != null ? Number(contrato.importe_licitacion) : null;
  const estado = String(contrato.estado || '');

  if (!objeto) return null;

  const prompt = `Eres un asistente que resume licitaciones públicas. Dado el siguiente contrato, extrae:
1. resumen: una frase clara de qué se pide (máx 150 caracteres)
2. sector: sector al que pertenece (ej: software, construcción, sanidad, consultoría, transporte, hostelería, etc.)
3. importe_estimado: el importe si se menciona, o null
4. plazo_o_estado: estado o plazo si se menciona
5. tipo: tipo de contrato (suministro, servicio, obra, concesión)

Responde SOLO en JSON válido.

Contrato:
- Objeto: ${objeto}
- Organismo: ${organismo}
- Importe: ${importe ?? 'No especificado'}
- Estado: ${estado}`;

  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    const raw = await callOllama(model, prompt);
    const parsed = raw ? parseResumen(raw) : null;
    if (parsed) {
      parsed.modelo = model;
      return parsed;
    }
  }

  return null;
}

function getReadConn() {
  const duckdb = require('duckdb');
  const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
  const WEB_STATE_PATH = process.env.DUCKDB_WEB_STATE_PATH || '/var/data/licitaciones/db/web-state.duckdb';
  // READ-ONLY: la base de ingesta nunca se abre en RW fuera del materializador.
  const db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
  db.exec("SET memory_limit = '2GB'; SET threads = 2; SET preserve_insertion_order = false;");
  const conn = db.connect();
  conn.exec("SET memory_limit = '2GB'; SET threads = 2; SET preserve_insertion_order = false;");
  // web-state attachado en RO para el JOIN de pendientes (conflicto solo
  // milisegundos con el web; si falla, reintenta).
  for (let i = 1; ; i++) {
    try {
      conn.run(`ATTACH '${WEB_STATE_PATH}' AS ws (READ_ONLY)`);
      break;
    } catch (e) {
      if (i >= 8 || !/Could not set lock|Conflicting lock/i.test(String(e?.message))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    }
  }
  return conn;
}

/** Escritura puntual en web-state (abrir → INSERT → cerrar, con reintentos). */
async function saveResumenState(id_contrato, resumen) {
  const duckdb = require('duckdb');
  const WEB_STATE_PATH = process.env.DUCKDB_WEB_STATE_PATH || '/var/data/licitaciones/db/web-state.duckdb';
  for (let attempt = 1; ; attempt++) {
    let sdb = null, sconn = null;
    try {
      sdb = new duckdb.Database(WEB_STATE_PATH);
      sconn = sdb.connect();
      await new Promise((resolve, reject) => {
        sconn.run(
          `INSERT INTO ia_resumenes
    (id_contrato, modelo, resumen, sector, tipo, importe_detectado, estado_detectado, fecha_generacion)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          id_contrato, resumen.modelo, resumen.resumen, resumen.sector, resumen.tipo, resumen.importe_detectado, resumen.estado_detectado,
          (err) => (err ? reject(err) : resolve())
        );
      });
      return;
    } catch (e) {
      if (attempt < 6 && /Could not set lock|Conflicting lock/i.test(String(e?.message))) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
        continue;
      }
      throw e;
    } finally {
      try { sconn && sconn.close(); } catch (_) {}
      try { sdb && sdb.close(); } catch (_) {}
    }
  }
}

async function runBatchResumen(limit = 500) {
  if (!IA_API_KEY) {
    log('IA key no configurada (NAN_API_KEY / /root/.nan_api_key) — skip batch resumen');
    return { generados: 0, errores: 0, omitidos: 0 };
  }

  let conn;
  try {
    conn = getReadConn();

    const rows = await new Promise((resolve, reject) => {
      conn.all(
        `SELECT v.id, v.objeto, v.organismo, v.importe_licitacion, v.estado
         FROM contratos_vivos v
         LEFT JOIN ws.ia_resumenes r ON r.id_contrato = v.id
         WHERE r.id_contrato IS NULL
           AND v.objeto IS NOT NULL
           AND LENGTH(TRIM(v.objeto)) > 20
         ORDER BY v.fecha_publicacion DESC NULLS LAST
         LIMIT ?`,
        [limit],
        (err, r) => {
          if (err) reject(err);
          else resolve(r || []);
        }
      );
    });

    if (!rows.length) {
      log('No hay contratos pendientes de resumen');
      return { generados: 0, errores: 0, omitidos: 0 };
    }

    log(`Resumiendo ${rows.length} contratos (límite ${limit})`);
    let generados = 0;
    let errores = 0;

    for (const contrato of rows) {
      try {
        const resumen = await generateResumen(contrato);
        if (!resumen) {
          errores++;
          continue;
        }
        await saveResumenState(contrato.id, resumen);
        generados++;
      } catch (err) {
        log(`Error guardando resumen para ${contrato.id}: ${err.message}`);
        errores++;
      }
    }

    log(`Batch resumen completado: ${generados} generados, ${errores} errores`);
    return { generados, errores, omitidos: 0 };
  } catch (err) {
    log(`Error en batch resumen: ${err.message}`);
    return { generados: 0, errores: 1, omitidos: 0 };
  } finally {
    if (conn) {
      try { conn.close(); } catch (_) {}
    }
  }
}

module.exports = { runBatchResumen, generateResumen };
