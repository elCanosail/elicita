/**
 * Jev Matching Runner (SOMBRA) — Elicita
 * ═══════════════════════════════════════════════════════════════════
 *
 * Scoring de licitaciones nuevas con TypeSafe Jev (System One) para los
 * perfiles IA activos. Fase sombra del plan
 * docs/plans/jev-alertas-incumbencia.md:
 *
 *  - Mismo flujo de datos que matching-runner.js (query con REST fallback,
 *    findContratosNuevos, escritura en ia_matching_results). La maquinaria
 *    DuckDB se duplica a propósito durante la fase sombra; si se adopta Jev
 *    (F5), refactorizar a lib compartida.
 *  - Scoring: 1 llamada Jev por perfil con un Noul por licitación
 *    (probabilidad de incumbencia, fan-out paralelo). score = round(p * 100).
 *  - NO envía emails (enviado_email = false). Solo evidencia de sombra
 *    para comparar con Gemma antes del switch.
 *
 * - Standalone: node ingesta/jev-matching.js [--days N] [--perfil USER_ID] [--write-db]
 * - Por defecto APPENDEA el resultado a ingesta/logs/jev-shadow.jsonl (histórico
 *   de sombra; no toca ia_matching_results para no pisar las filas de Gemma,
 *   clave (id_contrato, user_id) compartida). --write-db escribe también en
 *   DuckDB (solo tests controlados).
 * - Log: ingesta/logs/jev-matching.log
 * - API key: /root/.typesafe_api_key (fuera de git y del env de PM2).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

// ── Config ────────────────────────────────────────────────────────────────
const BASE_DIR = __dirname;
const WEB_DIR = path.join(BASE_DIR, '..', 'web');
const LOG_FILE = path.join(BASE_DIR, 'logs', 'jev-matching.log');
const MAX_LOG_SIZE = 50 * 1024 * 1024;
const MAX_CANDIDATES = 50;
const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
// Estado web (perfiles, matching): acceso puntual con attach/detach y
// reintentos. NUNCA abrir licitaciones.duckdb en RW desde aquí.
const WEB_STATE_PATH = process.env.DUCKDB_WEB_STATE_PATH || '/var/data/licitaciones/db/web-state.duckdb';
const ELICITA_API_URL = process.env.ELICITA_API_URL || process.env.ELICITA_URL || 'http://127.0.0.1:4321';
const KEY_PATH = '/root/.typesafe_api_key';
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--days') args.days = Number(process.argv[++i]);
  else if (process.argv[i] === '--perfil') args.perfil = process.argv[++i];
  else if (process.argv[i] === '--write-db') args.writeDb = true;
}
const DIAS = args.days && args.days > 0 ? args.days : 1;

function loadEnv() {
  if (process.env.ELICITA_URL) return;
  const envPath = path.join(WEB_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// ── Logging ───────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) { try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (_) {} }
    } catch (_) {}
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

// ── DuckDB (idéntico a matching-runner: local con REST fallback) ──────────
let db = null;
let conn = null;
let useRestFallback = false;

function restHeaders(extra = {}) {
  let host = '';
  try { host = new URL(ELICITA_API_URL).hostname; } catch (_) {}
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  return { 'Content-Type': 'application/json', ...(loopback ? { 'x-real-ip': '127.0.0.1' } : {}), ...extra };
}

function initDb() {
  return new Promise((resolve) => {
    try {
      db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
      conn = db.connect();
      conn.all('SELECT 1', (err) => {
        if (err) {
          log(`DuckDB local no disponible (${err.message}) — usando REST fallback`);
          useRestFallback = true; closeDb();
        }
        resolve();
      });
    } catch (e) {
      log(`DuckDB local error: ${e.message} — usando REST fallback`);
      useRestFallback = true; closeDb(); resolve();
    }
  });
}

function closeDb() {
  if (conn) { try { conn.close(); } catch (_) {} conn = null; }
  if (db) { try { db.close(); } catch (_) {} db = null; }
}

function queryLocal(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!conn) return reject(new Error('DuckDB local connection not available'));
    conn.all(sql, ...params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Adjunta web-state puntualmente (attach → op → detach) con reintentos.
 * El web lo abre por operación; la contención dura milisegundos.
 */
async function withWs(fn) {
  if (!conn) return fn();
  let attached = false;
  for (let i = 1; ; i++) {
    try {
      await conn.run(`ATTACH '${WEB_STATE_PATH}' AS ws`);
      attached = true;
      break;
    } catch (e) {
      if (/already/i.test(String(e?.message))) { attached = true; break; }
      if (i >= 8 || !/lock|Conflicting/i.test(String(e?.message))) throw e;
      await sleepMs(800);
    }
  }
  try {
    return await fn();
  } finally {
    if (attached) { try { await conn.run('DETACH ws'); } catch (_) {} }
  }
}

/** Conexión de escritura sobre web-state, por operación. */
async function withWsWrite(fn) {
  for (let i = 1; ; i++) {
    let wdb = null, wconn = null;
    try {
      wdb = new duckdb.Database(WEB_STATE_PATH);
      wconn = wdb.connect();
      wconn.exec("SET memory_limit = '512MB'; SET threads = 2;");
      return await fn(wconn);
    } catch (e) {
      if (i < 6 && /Could not set lock|Conflicting lock/i.test(String(e?.message))) {
        await sleepMs(800);
        continue;
      }
      throw e;
    } finally {
      try { wconn && wconn.close(); } catch (_) {}
      try { wdb && wdb.close(); } catch (_) {}
    }
  }
}

async function queryRest(sql) {
  const url = `${ELICITA_API_URL}/api/admin/duckdb-query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: restHeaders(),
    body: JSON.stringify({ sql }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`REST query error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!Array.isArray(data.rows)) throw new Error('Respuesta inesperada de duckdb-query');
  return data.rows;
}

function interpolate(sql, params = []) {
  let idx = 0;
  return sql.replace(/\?/g, () => {
    const p = params[idx++];
    if (p === null || p === undefined) return 'NULL';
    if (typeof p === 'number') return String(p);
    if (p instanceof Date) return `'${p.toISOString()}'`;
    return "'" + String(p).replace(/'/g, "''") + "'";
  });
}

async function query(sql, params = []) {
  if (useRestFallback) return queryRest(interpolate(sql, params));
  try {
    return await queryLocal(sql, params);
  } catch (e) {
    log(`Query local falló (${e.message}) — switching a REST fallback`);
    useRestFallback = true; closeDb();
    return queryRest(interpolate(sql, params));
  }
}

// ── Perfiles y candidatos (mismas reglas que matching-runner) ─────────────
function getCpvPrefixes(cpvs) {
  return (cpvs || [])
    .map((c) => String(c).replace('.0', '').trim().replace(/\s+/g, '').slice(0, 5))
    .filter((c) => /^\d{5}$/.test(c));
}

function sanitizeTextArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x || '').trim()).filter((x) => x.length > 0);
}

async function getPerfiles() {
  let sql = `SELECT user_id, email, nombre, cpvs, organismos, fuentes, importe_min, importe_max, sectores
             FROM ws.ia_perfiles WHERE activo = true`;
  if (args.perfil) sql += ` AND user_id = '${String(args.perfil).replace(/'/g, "''")}'`;
  return withWs(() => query(sql));
}

async function findContratosNuevos(perfil, userId) {
  const conditions = [];
  const params = [];
  conditions.push('fecha_publicacion >= ?');
  params.push(new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  conditions.push(`id NOT IN (SELECT id_contrato FROM ws.ia_matching_results WHERE user_id = ?)`);
  params.push(userId);
  const cpvs = getCpvPrefixes(sanitizeTextArray(perfil.cpvs));
  if (cpvs.length > 0) {
    const placeholders = cpvs.map(() => '?').join(',');
    // Ojo: SUBSTRING sin REPLACE() — el endpoint /api/admin/duckdb-query prohíbe
    // la palabra "replace" en el SQL (colisión función/keyword). El matching-runner
    // solo puede usar REPLACE vía conexión local (el scheduler dueña del lock).
    conditions.push(`SUBSTRING(cpv, 1, 5) IN (${placeholders})`);
    params.push(...cpvs);
  }
  const fuentes = sanitizeTextArray(perfil.fuentes).map((f) => f.toUpperCase());
  if (fuentes.length > 0) {
    conditions.push(`UPPER(fuente) IN (${fuentes.map(() => '?').join(',')})`);
    params.push(...fuentes);
  }
  const organismos = sanitizeTextArray(perfil.organismos);
  if (organismos.length > 0) {
    conditions.push(`(${organismos.map(() => 'LOWER(organismo) LIKE ?').join(' OR ')})`);
    params.push(...organismos.map((o) => `%${o.toLowerCase()}%`));
  }
  if (perfil.importe_min != null && Number.isFinite(Number(perfil.importe_min)) && Number(perfil.importe_min) > 0) {
    conditions.push('importe_licitacion >= ?'); params.push(Number(perfil.importe_min));
  }
  if (perfil.importe_max != null && Number.isFinite(Number(perfil.importe_max)) && Number(perfil.importe_max) > 0) {
    conditions.push('importe_licitacion <= ?'); params.push(Number(perfil.importe_max));
  }
  const sql = `SELECT id, fuente, organismo, objeto, cpv, importe_licitacion, fecha_publicacion
               FROM contratos_vivos WHERE ${conditions.join(' AND ')}
               ORDER BY fecha_publicacion DESC, id DESC LIMIT ${MAX_CANDIDATES}`;
  return withWs(() => query(sql, params));
}

// ── Jev ───────────────────────────────────────────────────────────────────
function jevState(perfil) {
  const cpvs = (perfil.cpvs || []).join(', ') || 'ninguno';
  const sectores = (perfil.sectores || []).join(', ') || 'no especificados';
  const organismos = (perfil.organismos || []).join(', ') || 'ninguno';
  const min = perfil.importe_min != null ? Number(perfil.importe_min).toLocaleString('es-ES') : null;
  const max = perfil.importe_max != null ? Number(perfil.importe_max).toLocaleString('es-ES') : null;
  const rango = min && max ? `${min} a ${max} €` : min ? `desde ${min} €` : max ? `hasta ${max} €` : 'sin límite';
  return `Empresa interesada en licitaciones públicas. Actividad: ${sectores}. ` +
         `Códigos CPV de interés: ${cpvs}. Organismos de interés: ${organismos}. ` +
         `Rango de importes de interés: ${rango}.`;
}

async function jevScorePerfil(perfil, contratos) {
  const questions = {};
  for (const c of contratos) {
    const imp = c.importe_licitacion != null ? `${Number(c.importe_licitacion).toLocaleString('es-ES')} €` : 'no especificado';
    questions[c.id] = {
      type: 'noul',
      instructions: `Licitación pública: Fuente ${c.fuente || '—'}. Organismo: ${String(c.organismo || '—').slice(0, 80)}. ` +
        `Importe: ${imp}. Objeto: ${String(c.objeto || '').slice(0, 350)}. ` +
        `— ¿Es de incumbencia para esta empresa, es decir, corresponde a su actividad habitual y sería razonable ` +
        `que se presentara o resultara adjudicataria?`,
      criteria: { true: 'Claramente dentro de la actividad habitual de la empresa',
                  false: 'Fuera de su actividad o perfil' },
    };
  }
  const body = { model: JEV_MODEL, state: jevState(perfil), questions };
  const req = await fetch(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${fs.readFileSync(KEY_PATH, 'utf8').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!req.ok) throw new Error(`Jev API ${req.status}: ${await req.text()}`);
  const j = await req.json();
  const out = {};
  for (const [k, v] of Object.entries(j.answers || {})) out[k] = v.noul;
  return out;
}

// ── Escritura sombra (sin email) ──────────────────────────────────────────
function appendShadowJsonl(matches, userId) {
  const file = path.join(BASE_DIR, 'logs', 'jev-shadow.jsonl');
  const ts = new Date().toISOString();
  const lines = matches.map((m) => JSON.stringify({ ts, user_id: userId, ...m }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
}

async function saveShadow(matches, userId) {
  appendShadowJsonl(matches, userId);
  if (!args.writeDb) return;
  if (!conn) {
    const url = `${ELICITA_API_URL}/api/admin/write-matching`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matches: matches.map((m) => ({ ...m, user_id: userId, enviado_email: false, fecha_envio: null })) }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`write-matching ${res.status}: ${await res.text()}`);
    return;
  }
  const now = new Date().toISOString();
  await withWsWrite(async (wconn) => {
    for (const m of matches) {
      await new Promise((resolve, reject) => {
        wconn.run(
          `INSERT INTO ia_matching_results (id_contrato, user_id, score, motivo, fecha_match, enviado_email, fecha_envio)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id_contrato, user_id) DO UPDATE SET
             score = EXCLUDED.score, motivo = EXCLUDED.motivo, fecha_match = EXCLUDED.fecha_match,
             enviado_email = EXCLUDED.enviado_email, fecha_envio = EXCLUDED.fecha_envio`,
          m.id_contrato, userId, m.score, m.motivo, now, false, null,
          (err) => (err ? reject(err) : resolve())
        );
      });
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  loadEnv();
  if (!fs.existsSync(KEY_PATH)) { log('Sin /root/.typesafe_api_key — saliendo'); process.exit(1); }
  await initDb();
  const perfiles = await getPerfiles();
  log(`F3 sombra: ${perfiles.length} perfiles activos, ventana ${DIAS} día(s)`);
  for (const perfil of perfiles) {
    try {
      const contratos = await findContratosNuevos(perfil, perfil.user_id);
      if (!contratos.length) { log(`perfil ${perfil.user_id}: sin candidatos nuevos`); continue; }
      const t0 = Date.now();
      const probs = await jevScorePerfil(perfil, contratos);
      const matches = contratos
        .filter((c) => probs[c.id] != null)
        .map((c) => ({
          id_contrato: c.id,
          score: Math.round(probs[c.id] * 100),
          motivo: `jev p=${probs[c.id].toFixed(2)} (sombra)`,
        }));
      await saveShadow(matches, perfil.user_id);
      log(`perfil ${perfil.user_id}: ${matches.length}/${contratos.length} puntuados y guardados en ${Date.now() - t0}ms (sombra, sin email)`);
    } catch (e) {
      log(`perfil ${perfil.user_id}: ERROR ${e.message}`);
    }
  }
  closeDb();
  log('F3 sombra: fin');
})();
