/**
 * Matching Runner — Elicita
 * ═══════════════════════════════════════════════════════════════════
 *
 * Revisa perfiles IA activos, busca contratos nuevos en DuckDB,
 * llama a Gemma 4 para scoring (fallback DeepSeek), guarda resultados
 * y envía emails con Resend para scores >= 70.
 *
 * - Se ejecuta desde el scheduler después de la ingesta.
 * - También puede correr standalone: node ingesta/matching-runner.js
 * - Log: ingesta/logs/matching.log
 */

'use strict';

const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

// Reutilizar cliente IA y funciones
const { callModelWithFallback } = require('./ia-client');

// ── Config ────────────────────────────────────────────────────────────────
const BASE_DIR = __dirname;
const WEB_DIR = path.join(BASE_DIR, '..', 'web');
const LOG_FILE = path.join(BASE_DIR, 'logs', 'matching.log');
const MAX_LOG_SIZE = 50 * 1024 * 1024;
const MAX_CANDIDATES = 50;
const SCORE_EMAIL_THRESHOLD = 70;
const RESEND_RATE_LIMIT_MS = 500;
const FROM_EMAIL = 'alertas@elicita.es';
const FROM_NAME = 'Elicita';
const ELICITA_URL = process.env.ELICITA_URL || 'https://elicita.es';

const PRIMARY_MODEL = process.env.AI_MATCHING_MODEL_PRIMARY || 'deepseek-v4-flash';
const FALLBACK_MODEL = process.env.AI_MATCHING_MODEL_FALLBACK || 'gemma4';

// ── Cargar .env de web/ si faltan variables ──────────────────────────────
function loadEnv() {
  if (process.env.CLERK_SECRET_KEY && process.env.RESEND_API_KEY && process.env.OLLAMA_API_KEY) return;

  const envPath = path.join(WEB_DIR, '.env');
  if (!fs.existsSync(envPath)) return;

  const text = fs.readFileSync(envPath, 'utf-8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
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
      if (stat.size > MAX_LOG_SIZE) {
        try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (_) {}
      }
    } catch (_) {}
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

// ── DuckDB ────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
// Estado web (alertas, perfiles, resúmenes, matching): el web es su único
// escritor habitual; aquí se accede con attach/detach puntual con reintentos.
// NUNCA abrir licitaciones.duckdb en RW desde aquí: el web es el único
// proceso con lock de escritura sobre la base de ingesta.
const WEB_STATE_PATH = process.env.DUCKDB_WEB_STATE_PATH || '/var/data/licitaciones/db/web-state.duckdb';
const ELICITA_API_URL = process.env.ELICITA_API_URL || process.env.ELICITA_URL || 'http://127.0.0.1:4321';

// /api/admin/duckdb-query autoriza por x-real-ip (set por nginx/CF) y rechaza
// peticiones sin esa cabecera. En conexión directa a loopback nadie la añade,
// así que la enviamos nosotros (solo si el destino es loopback).
function restHeaders(extra = {}) {
  let host = '';
  try { host = new URL(ELICITA_API_URL).hostname; } catch (_) {}
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  return { 'Content-Type': 'application/json', ...(loopback ? { 'x-real-ip': '127.0.0.1' } : {}), ...extra };
}

let db = null;
let conn = null;
let useRestFallback = false;

function initDb() {
  return new Promise((resolve, reject) => {
    try {
      db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
      conn = db.connect();
      conn.all('SELECT 1', (err) => {
        if (err) {
          log(`DuckDB local no disponible (${err.message}) — usando REST fallback`);
          useRestFallback = true;
          closeDb();
          resolve();
        } else {
          resolve();
        }
      });
    } catch (e) {
      log(`DuckDB local error: ${e.message} — usando REST fallback`);
      useRestFallback = true;
      closeDb();
      resolve();
    }
  });
}

function closeDb() {
  if (conn) { try { conn.close(); } catch (_) {} conn = null; }
  if (db) { try { db.close(); } catch (_) {} db = null; }
}

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Adjunta web-state a la conexión de lectura de forma PUNTUAL (attach → op →
 * detach) con reintentos. El web mantiene el lock de web-state solo
 * milisegundos por operación, así que la contención se resuelve esperando.
 * NUNCA dejar ws attachado durante toda la corrida: bloquearía al web.
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

/**
 * Conexión de ESCRITURA sobre web-state, por operación (abrir → fn → cerrar).
 * Reemplaza al writeConn persistente sobre la base de ingesta.
 */
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

function queryLocal(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!conn) return reject(new Error('DuckDB local connection not available'));
    conn.all(sql, ...params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function queryRest(sql) {
  const url = `${ELICITA_API_URL}/api/admin/duckdb-query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: restHeaders(),
    body: JSON.stringify({ sql }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`REST query error ${res.status}: ${text}`);
  }
  const data = await res.json();
  if (!Array.isArray(data.rows)) throw new Error('Respuesta inesperada de duckdb-query');
  return data.rows;
}

async function query(sql, params = []) {
  if (useRestFallback) {
    let interpolated = sql;
    let idx = 0;
    interpolated = interpolated.replace(/\?/g, () => {
      const p = params[idx++];
      if (p === null || p === undefined) return 'NULL';
      if (typeof p === 'number') return String(p);
      if (p instanceof Date) return `'${p.toISOString()}'`;
      return "'" + String(p).replace(/'/g, "''") + "'";
    });
    return queryRest(interpolated);
  }
  try {
    return await queryLocal(sql, params);
  } catch (e) {
    log(`Query local falló (${e.message}) — switching a REST fallback`);
    useRestFallback = true;
    closeDb();
    let interpolated = sql;
    let idx = 0;
    interpolated = interpolated.replace(/\?/g, () => {
      const p = params[idx++];
      if (p === null || p === undefined) return 'NULL';
      if (typeof p === 'number') return String(p);
      if (p instanceof Date) return `'${p.toISOString()}'`;
      return "'" + String(p).replace(/'/g, "''") + "'";
    });
    return queryRest(interpolated);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function getCpvPrefixes(cpvs) {
  return (cpvs || [])
    .map((c) => String(c).replace('.0', '').trim().replace(/\s+/g, '').slice(0, 5))
    .filter((c) => /^\d{5}$/.test(c));
}

function sanitizeTextArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x || '').trim()).filter((x) => x.length > 0);
}

async function findContratosNuevos(perfil, userId) {
  const conditions = [];
  const params = [];

  // Solo contratos de las últimas 24h no matcheados previamente para este usuario
  conditions.push('fecha_publicacion >= ?');
  params.push(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10));

  // Excluir ya procesados (tabla en web-state — requiere attach ws)
  conditions.push(`id NOT IN (SELECT id_contrato FROM ws.ia_matching_results WHERE user_id = ?)`);
  params.push(userId);

  // CPV
  const cpvs = getCpvPrefixes(sanitizeTextArray(perfil.cpvs));
  if (cpvs.length > 0) {
    const placeholders = cpvs.map(() => '?').join(',');
    conditions.push(`SUBSTRING(REPLACE(REPLACE(cpv, '.0', ''), ' ', ''), 1, 5) IN (${placeholders})`);
    params.push(...cpvs);
  }

  // Fuentes
  const fuentes = sanitizeTextArray(perfil.fuentes).map((f) => f.toUpperCase());
  if (fuentes.length > 0) {
    conditions.push(`UPPER(fuente) IN (${fuentes.map(() => '?').join(',')})`);
    params.push(...fuentes);
  }

  // Organismos
  const organismos = sanitizeTextArray(perfil.organismos);
  if (organismos.length > 0) {
    conditions.push(`(${organismos.map(() => 'LOWER(organismo) LIKE ?').join(' OR ')})`);
    params.push(...organismos.map((o) => `%${o.toLowerCase()}%`));
  }

  // Importe
  if (perfil.importe_min != null && Number.isFinite(Number(perfil.importe_min)) && Number(perfil.importe_min) > 0) {
    conditions.push('importe_licitacion >= ?');
    params.push(Number(perfil.importe_min));
  }
  if (perfil.importe_max != null && Number.isFinite(Number(perfil.importe_max)) && Number(perfil.importe_max) > 0) {
    conditions.push('importe_licitacion <= ?');
    params.push(Number(perfil.importe_max));
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const sql = `
    SELECT id, fuente, organismo, objeto, cpv, importe_licitacion, fecha_publicacion
    FROM contratos_vivos
    ${where}
    ORDER BY fecha_publicacion DESC, id DESC
    LIMIT ?
  `;

  // El NOT IN consulta ws.ia_matching_results → requiere web-state attachado
  return withWs(() => query(sql, [...params, MAX_CANDIDATES]));
}

function buildPrompt(perfil, contratos) {
  const cpvs = (perfil.cpvs || []).join(', ') || 'ninguno';
  const organismos = (perfil.organismos || []).join(', ') || 'ninguno';
  const sectores = (perfil.sectores || []).join(', ') || 'ninguno';
  const importeMin = perfil.importe_min != null ? `€${perfil.importe_min.toLocaleString('es-ES')}` : 'sin límite';
  const importeMax = perfil.importe_max != null ? `€${perfil.importe_max.toLocaleString('es-ES')}` : 'sin límite';

  const lista = contratos
    .map((c, i) => {
      const objeto = String(c.objeto || '').slice(0, 200).replace(/\n/g, ' ');
      const importe = c.importe_licitacion != null ? Number(c.importe_licitacion) : null;
      const importeStr = importe != null && Number.isFinite(importe) ? `€${importe.toLocaleString('es-ES')}` : 'no especificado';
      return `${i + 1}. ID: ${c.id}\n   Objeto: ${objeto}\n   Organismo: ${c.organismo || '—'}\n   CPV: ${c.cpv || '—'}\n   Importe: ${importeStr}\n   Fuente: ${c.fuente || '—'}`;
    })
    .join('\n\n');

  return `Eres un asistente que evalúa la relevancia de licitaciones públicas para el perfil de un usuario.

Perfil del usuario:
- CPVs de interés: ${cpvs}
- Organismos de interés: ${organismos}
- Sectores de interés: ${sectores}
- Importe mínimo: ${importeMin}
- Importe máximo: ${importeMax}

Contratos candidatos:
${lista}

Para cada contrato, devuelve un JSON array con:
- id_contrato: el id del contrato
- score: relevancia de 0 a 100 (0 = irrelevante, 100 = match perfecto)
- motivo: una frase explicando por qué es relevante (o por qué no)

El score debe reflejar: coincidencia de CPV, coincidencia de organismo, rango de importe, relevancia semántica del objeto con los sectores del usuario.

Devuelve SOLO el JSON array, sin markdown ni explicaciones.`;
}

function cleanJsonBlock(raw) {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  }
  s = s.replace(/,\s*(?=[}\]])/g, '');
  return s;
}

function parseMatches(raw, contratos) {
  const cleaned = cleanJsonBlock(raw);
  let parsed = [];
  try {
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    const match = cleaned.match(/\[([\s\S]*)\]/);
    if (match) {
      try {
        parsed = JSON.parse(`[${match[1]}]`);
        if (!Array.isArray(parsed)) parsed = [];
      } catch {
        parsed = [];
      }
    }
  }

  const validIds = new Set(contratos.map((c) => c.id));
  return parsed
    .filter((item) => item && validIds.has(item.id_contrato))
    .map((item) => ({
      id_contrato: item.id_contrato,
      score: Math.max(0, Math.min(100, Number(item.score) || 0)),
      motivo: String(item.motivo || '').slice(0, 300),
    }));
}

async function saveMatches(conn, matches, userId, enviadoEmail = false, fechaEnvio = null) {
  // Si no hay conexión de escritura, guardar vía REST endpoint del servidor web.
  if (!conn) {
    return saveMatchesViaRest(matches.map((m) => ({ ...m, user_id: userId, enviado_email: enviadoEmail, fecha_envio: fechaEnvio })));
  }

  const now = new Date().toISOString();
  for (const m of matches) {
    try {
      await new Promise((resolve, reject) => {
        conn.run(
          `INSERT INTO ia_matching_results (id_contrato, user_id, score, motivo, fecha_match, enviado_email, fecha_envio)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id_contrato, user_id) DO UPDATE SET
             score = EXCLUDED.score,
             motivo = EXCLUDED.motivo,
             fecha_match = EXCLUDED.fecha_match,
             enviado_email = EXCLUDED.enviado_email,
             fecha_envio = EXCLUDED.fecha_envio`,
          m.id_contrato,
          userId,
          m.score,
          m.motivo,
          now,
          enviadoEmail,
          fechaEnvio,
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } catch (err) {
      log(`Error guardando match ${m.id_contrato}: ${err.message}`);
    }
  }
}

async function saveMatchesViaRest(matches) {
  try {
    const url = `${ELICITA_API_URL}/api/admin/write-matching`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matches }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`write-matching ${res.status}: ${text}`);
    }
    const data = await res.json();
    log(`[REST] Guardados ${data.inserted || 0} matches vía ${url}`);
    return data.inserted || 0;
  } catch (err) {
    log(`[REST] Error guardando matches: ${err.message}`);
    return 0;
  }
}

async function markEnviados(conn, matches, userId) {
  // El endpoint write-matching ya guarda enviado_email; solo usamos esta función
  // cuando writeConn está disponible y queremos marcar envíos posteriores.
  if (!conn) {
    return saveMatchesViaRest(matches.map((m) => ({ ...m, user_id: userId, enviado_email: true, fecha_envio: new Date().toISOString() })));
  }

  const now = new Date().toISOString();
  for (const m of matches) {
    try {
      await new Promise((resolve, reject) => {
        conn.run(
          `UPDATE ia_matching_results SET enviado_email = true, fecha_envio = ? WHERE id_contrato = ? AND user_id = ?`,
          now,
          m.id_contrato,
          userId,
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } catch (err) {
      log(`Error marcando envío ${m.id_contrato}: ${err.message}`);
    }
  }
}

// ── Resúmenes ───────────────────────────────────────────────────────────────
async function fetchResumenes(ids) {
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = await withWs(() =>
    query(
      `SELECT id_contrato, resumen FROM ws.ia_resumenes WHERE id_contrato IN (${placeholders})`,
      ids
    )
  );
  const map = {};
  for (const r of rows) map[r.id_contrato] = r.resumen;
  return map;
}

// ── Email ───────────────────────────────────────────────────────────────────
function formatImporte(val) {
  if (val == null || val === 0) return '—';
  const num = Number(val);
  if (isNaN(num)) return '—';
  if (num >= 1_000_000) return `€ ${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `€ ${(num / 1_000).toFixed(0)}K`;
  return `€ ${num.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d) {
  if (!d) return '—';
  return String(d).slice(0, 10);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/\u003c/g, '&lt;')
    .replace(/\u003e/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linkContrato(fuente, id) {
  return `${ELICITA_URL}/licitacion/${encodeURIComponent(String(fuente || 'unknown'))}/${encodeURIComponent(String(id || ''))}`;
}

function buildEmailHTML({ nombre, contratos, resumenes }) {
  const rows = contratos
    .map((c) => {
      const resumen = resumenes[c.id] || c.motivo;
      return `
      <tr>
        <td style="padding:14px 10px;border-bottom:1px solid #222;vertical-align:top;">
          <div style="font-size:14px;font-weight:600;line-height:1.4;margin-bottom:6px;">
            <a href="${escapeHtml(linkContrato(c.fuente, c.id))}" style="color:#10b981;text-decoration:none;">
              ${escapeHtml((c.objeto || 'Sin título').slice(0, 110))}${String(c.objeto || '').length > 110 ? '…' : ''}
            </a>
          </div>
          <div style="font-size:12px;color:#a0a0a0;line-height:1.5;">
            ${escapeHtml((c.organismo || '—').slice(0, 90))}
          </div>
          ${resumen ? `<div style="margin-top:8px;padding:8px 10px;background:#0f1f18;border-left:2px solid #10b981;border-radius:4px;font-size:12px;color:#d0d0d0;line-height:1.5;">
            <span style="color:#10b981;font-weight:600;">Match ${c.score}/100:</span> ${escapeHtml(resumen)}
          </div>` : ''}
        </td>
        <td style="padding:14px 10px;border-bottom:1px solid #222;vertical-align:top;font-size:13px;color:#e5e5e5;font-family:'JetBrains Mono',monospace;white-space:nowrap;">
          ${formatImporte(c.importe_licitacion)}
        </td>
        <td style="padding:14px 10px;border-bottom:1px solid #222;vertical-align:top;font-size:12px;color:#737373;font-family:'JetBrains Mono',monospace;white-space:nowrap;">
          ${formatDate(c.fecha_publicacion)}
        </td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Licitaciones recomendadas para ti — Elicita</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e5e5e5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0a0a0a;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;width:100%;background:#111;border:1px solid #222;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="padding:28px 24px 20px;border-bottom:1px solid #222;">
              <div style="font-family:'JetBrains Mono',monospace;font-size:18px;color:#10b981;margin-bottom:6px;">
                elicita<span style="color:#10b981;">_</span>
              </div>
              <h1 style="margin:0;font-size:20px;font-weight:600;color:#f5f5f5;">${nombre ? `Hola, ${escapeHtml(nombre)}` : 'Hola'}</h1>
              <p style="margin:8px 0 0;font-size:14px;color:#a0a0a0;line-height:1.5;">
                ${contratos.length} licitación${contratos.length === 1 ? '' : 'es'} coinciden con tu perfil IA.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 12px 16px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
                <thead>
                  <tr>
                    <th align="left" style="padding:10px 10px 8px;font-size:11px;font-weight:600;color:#737373;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #333;">Licitación</th>
                    <th align="left" style="padding:10px 10px 8px;font-size:11px;font-weight:600;color:#737373;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #333;">Importe</th>
                    <th align="left" style="padding:10px 10px 8px;font-size:11px;font-weight:600;color:#737373;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #333;">Publicación</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 24px;text-align:center;">
              <a href="${ELICITA_URL}/cuenta/perfil-ia" style="display:inline-block;background:#10b981;color:#000;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">
                Gestionar perfil IA →
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 24px;border-top:1px solid #222;text-align:center;font-size:12px;color:#525252;line-height:1.5;">
              <p style="margin:0 0 8px;">
                <a href="${ELICITA_URL}/cuenta/perfil-ia" style="color:#737373;text-decoration:underline;">Configurar perfil IA</a> ·
                <a href="mailto:contacto@elicita.es?subject=Unsubscribe%20alertas%20IA" style="color:#737373;text-decoration:underline;">Darse de baja</a>
              </p>
              <p style="margin:0;font-family:'JetBrains Mono',monospace;font-size:11px;color:#3a3a3a;">
                elicita_ · Inteligencia sobre contratación pública
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY no configurada');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json().catch(() => ({}));
  return data.id || 'ok';
}

// ── Perfiles ─────────────────────────────────────────────────────────────────
async function getActiveProfiles() {
  return withWs(() =>
    query(
      `SELECT user_id, email, nombre, cpvs, organismos, fuentes, importe_min, importe_max, sectores
       FROM ws.ia_perfiles WHERE activo = true`
    )
  );
}

// ── Main ───────────────────────────────────────────────────────────────────
async function runMatching(options = {}) {
  loadEnv();
  const startTime = Date.now();
  // Reintentar DuckDB local en cada ciclo: el fallback REST es para fallos
  // puntuales (p. ej. swap del fichero en materialización), no un estado permanente.
  useRestFallback = false;
  log('Iniciando matching de perfiles IA');

  if (!process.env.OLLAMA_API_KEY) {
    log('ERROR: OLLAMA_API_KEY no configurada');
    return { ok: false, error: 'OLLAMA_API_KEY no configurada' };
  }

  const externalQuery = options.queryFn || null;
  if (!externalQuery) {
    await initDb();
    log('DuckDB conectado');
  } else {
    log('Usando conexión DuckDB inyectada');
  }

  // Escritura de matches/envíos: ahora sobre WEB-STATE, por operación
  // (sin conexión persistente — el lock es breve y con reintentos).

  let usuariosProcesados = 0;
  let contratosMatcheados = 0;
  let emailsEnviados = 0;
  let errores = 0;

  try {
    const perfiles = await getActiveProfiles();
    log(`${perfiles.length} perfiles activos`);

    for (const perfil of perfiles) {
      try {
        const userId = perfil.user_id;
        const email = perfil.email;
        if (!email) {
          log(`[SKIP] ${userId}: sin email`);
          continue;
        }

        const contratos = await findContratosNuevos(perfil, userId);
        if (!contratos.length) {
          log(`[OK] ${email}: 0 candidatos nuevos`);
          usuariosProcesados++;
          continue;
        }

        log(`[MATCHING] ${email}: ${contratos.length} candidatos`);
        const prompt = buildPrompt(perfil, contratos);
        const iaRes = await callModelWithFallback(prompt, PRIMARY_MODEL, FALLBACK_MODEL, 0.2);

        if (!iaRes.ok || !iaRes.content) {
          log(`[ERROR IA] ${email}: ${iaRes.error}`);
          errores++;
          continue;
        }

        const matches = parseMatches(iaRes.content, contratos);
        contratosMatcheados += matches.length;
        log(`[OK IA] ${email}: ${matches.length} matches (modelo ${iaRes.model}${iaRes.fallback ? ' fallback' : ''})`);

        // Guardar matches (web-state; fallback REST si falla la escritura directa)
        try {
          await withWsWrite((wc) => saveMatches(wc, matches, userId));
        } catch (e) {
          log(`Escritura directa falló (${e.message}) — probando REST`);
          await saveMatches(null, matches, userId);
        }

        // Enviar email si hay matches >= threshold
        const topMatches = matches.filter((m) => m.score >= SCORE_EMAIL_THRESHOLD);
        if (topMatches.length > 0 && process.env.RESEND_API_KEY) {
          const ids = topMatches.map((m) => m.id_contrato);
          const resumenes = await fetchResumenes(ids);
          const contratosEmail = topMatches
            .map((m) => ({
              ...m,
              ...(contratos.find((c) => c.id === m.id_contrato) || {}),
            }));

          const html = buildEmailHTML({
            nombre: perfil.nombre || '',
            contratos: contratosEmail,
            resumenes,
          });

          const subject = `${topMatches.length} ${topMatches.length === 1 ? 'licitación recomendada' : 'licitaciones recomendadas'} para ti — Elicita`;
          const id = await sendEmail({ to: email, subject, html });
          log(`[EMAIL] ${email}: ${topMatches.length} contratos (Resend id ${id})`);

          try {
            await withWsWrite((wc) => markEnviados(wc, topMatches, userId));
          } catch (e) {
            log(`Marcado de envíos falló (${e.message}) — probando REST`);
            await markEnviados(null, topMatches, userId);
          }
          emailsEnviados++;

          await new Promise((r) => setTimeout(r, RESEND_RATE_LIMIT_MS));
        }

        usuariosProcesados++;
      } catch (err) {
        log(`[ERROR USUARIO] ${perfil.user_id}: ${err.message}`);
        errores++;
      }
    }
  } catch (err) {
    log(`[FATAL] ${err.message}`);
    errores++;
  } finally {
    closeDb();
  }

  const durationMs = Date.now() - startTime;
  log(`Resumen: ${usuariosProcesados} usuarios, ${contratosMatcheados} matches, ${emailsEnviados} emails, ${errores} errores en ${durationMs}ms`);

  return {
    ok: errores === 0,
    usuarios_procesados: usuariosProcesados,
    contratos_matcheados: contratosMatcheados,
    emails_enviados: emailsEnviados,
    errores,
    durationMs,
  };
}

if (require.main === module) {
  runMatching()
    .then((res) => {
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      log(`Excepción no controlada: ${err.message}`);
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runMatching };
