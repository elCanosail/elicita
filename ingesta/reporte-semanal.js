/**
 * Reporte semanal automático — Elicita
 * ═══════════════════════════════════════════════════════════════════
 *
 * Cada lunes a las 08:00 UTC:
 * 1. Lee usuarios Pro/Empresa desde Clerk
 * 2. Para cada usuario, genera resumen semanal personalizado según:
 *    - CPVs de alertas
 *    - Organismos seguidos
 *    - Competidores seguidos
 * 3. Envía email (HTML tema claro + texto plano) via Resend
 *
 * También puede ejecutarse manualmente: node ingesta/reporte-semanal.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');
// Fase 2 plan BORME (2026-10-14): actos registrales de los perfiles seguidos.
const { queryBormeActosSeguidos, groupActosByDate } = require('./lib/borme-actos');

// ── Config ─────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const ELICITA_URL = process.env.ELICITA_URL || 'http://127.0.0.1:4321';

// /api/admin/duckdb-query autoriza por x-real-ip (set por nginx/CF) y rechaza
// peticiones sin esa cabecera. En conexión directa a loopback nadie la añade,
// así que la enviamos nosotros (solo si el destino es loopback).
function restHeaders(baseUrl, extra = {}) {
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch (_) {}
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  return { 'Content-Type': 'application/json', ...(loopback ? { 'x-real-ip': '127.0.0.1' } : {}), ...extra };
}
const FROM_EMAIL = process.env.REPORTE_FROM || 'Elicita <reportes@elicita.es>';

// Cargar .env de web/ si faltan variables (mismo patrón que alertas-runner)
function loadEnv() {
  if (process.env.CLERK_SECRET_KEY && process.env.RESEND_API_KEY) return;
  const envPath = path.join(__dirname, '..', 'web', '.env');
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
loadEnv();

const LOG_FILE = path.join(__dirname, 'logs', 'reporte-semanal.log');
const MAX_LOG_SIZE = 50 * 1024 * 1024;

// Reasignar variables que pueden haberse cargado desde .env
const _CLERK_SECRET = process.env.CLERK_SECRET_KEY || CLERK_SECRET;
const _RESEND_KEY = process.env.RESEND_API_KEY || RESEND_KEY;
const _ELICITA_URL = process.env.ELICITA_URL || ELICITA_URL;
const _FROM_EMAIL = process.env.REPORTE_FROM || FROM_EMAIL;

const PRO_PLANS = new Set(['pro', 'empresa']);
const WEEK_DAYS_SPANISH = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS_SPANISH = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] [reporte-semanal] ${msg}`;
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

// ── DuckDB via REST fallback ───────────────────────────────────────────────
const WEB_HEALTH_URL = process.env.WEB_HEALTH_URL || 'http://127.0.0.1:4321/api/health';

let db = null;
let conn = null;
let useRestFallback = false;

async function healthCheckWeb() {
  try {
    const res = await fetch(WEB_HEALTH_URL, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

function initDb() {
  return new Promise((resolve, reject) => {
    try {
      db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
      conn = db.connect();
      conn.all('SELECT 1', (err) => {
        if (err) {
          // Probable lock conflict con el servidor web — usamos fallback
          log(`DuckDB local no disponible (${err.message}) — usando fallback vía API web`);
          useRestFallback = true;
          closeDb();
          resolve();
        } else {
          resolve();
        }
      });
    } catch (e) {
      log(`DuckDB local error: ${e.message} — usando fallback vía API web`);
      useRestFallback = true;
      closeDb();
      resolve();
    }
  });
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

function inlineParams(sql, params = []) {
  if (!params || params.length === 0) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === undefined) throw new Error('inlineParams: faltan parámetros');
    if (v === null) return 'NULL';
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

async function queryRest(sql, params = []) {
  const baseUrl = process.env.ELICITA_URL || ELICITA_URL;
  const url = `${baseUrl}/api/admin/duckdb-query`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: restHeaders(baseUrl),
      body: JSON.stringify({ sql: inlineParams(sql, params) }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`REST query error ${res.status}: ${text}`);
    }
    const data = await res.json();
    if (!Array.isArray(data.rows)) throw new Error('Respuesta inesperada de duckdb-query');
    return data.rows;
  } catch (e) {
    // Node <18 fetch puede fallar por keep-alive; fallback a http.request
    if (e.cause?.code === 'ECONNRESET' || e.code === 'ECONNRESET' || e.message?.includes('fetch failed') || e.message?.includes('ECONNRESET')) {
      return queryRestHttp(sql, params);
    }
    throw e;
  }
}

function queryRestHttp(sql, params = []) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const baseUrl = process.env.ELICITA_URL || ELICITA_URL;
    const url = new URL(`${baseUrl}/api/admin/duckdb-query`);
    const data = JSON.stringify({ sql: inlineParams(sql, params) });
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        ...restHeaders(baseUrl),
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`REST query error ${res.statusCode}: ${body}`));
          return;
        }
        try {
          const data = JSON.parse(body);
          if (!Array.isArray(data.rows)) throw new Error('Respuesta inesperada de duckdb-query');
          resolve(data.rows);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function queryLocalOrRest(sql, params = []) {
  if (useRestFallback) {
    return queryRest(sql, params);
  }
  return queryLocal(sql, params);
}

function closeDb() {
  try { if (conn) conn.close(); } catch (_) {}
  try { if (db) db.close(); } catch (_) {}
  conn = null;
  db = null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function isProUser(metadata) {
  const rawPlan = metadata?.plan;
  if (PRO_PLANS.has(rawPlan)) return true;
  // Legacy/inteligencia mapean a pro
  if (rawPlan === 'inteligencia' || rawPlan === 'starter' || rawPlan === 'monitor' || rawPlan === 'operador') return true;
  return false;
}

function getCpvPrefixes(cpvs) {
  if (!Array.isArray(cpvs) || cpvs.length === 0) return [];
  return cpvs
    .map(c => String(c).replace(/\.0$/, '').trim().slice(0, 5))
    .filter(c => /^\d{5}$/.test(c));
}

function formatImporte(importe) {
  if (importe == null || importe === '' || Number.isNaN(Number(importe))) return '—';
  const n = Number(importe);
  if (n >= 1_000_000_000) return `€${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `€${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `€${(n / 1_000).toFixed(1)}K`;
  return `€${n.toFixed(2)}`;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDateRange(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  const startDay = s.getUTCDate();
  const endDay = e.getUTCDate();
  const startMonth = MONTHS_SPANISH[s.getUTCMonth()];
  const endMonth = MONTHS_SPANISH[e.getUTCMonth()];
  if (startMonth === endMonth) {
    return `${startDay} al ${endDay} de ${startMonth}`;
  }
  return `${startDay} de ${startMonth} al ${endDay} de ${endMonth}`;
}

function buildExplorerUrl(params = {}) {
  const baseUrl = process.env.ELICITA_URL || ELICITA_URL;
  const url = new URL('/explorer', baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== '') {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function buildLicitacionLink(id, url) {
  if (url) return url;
  const baseUrl = process.env.ELICITA_URL || ELICITA_URL;
  return `${baseUrl}/monitor/licitacion/${encodeURIComponent(id)}`;
}

// ── Clerk users ─────────────────────────────────────────────────────────────
async function fetchClerkUsers() {
  const secret = process.env.CLERK_SECRET_KEY || CLERK_SECRET;
  if (!secret) throw new Error('CLERK_SECRET_KEY no configurada');

  const users = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await fetch(`https://api.clerk.com/v1/users?limit=${limit}&offset=${offset}`, {
      headers: {
        'Authorization': `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Clerk API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const batch = Array.isArray(data) ? data : (data.data || []);
    if (batch.length === 0) break;

    for (const u of batch) {
      const email = u.email_addresses?.find(ea => ea.id === u.primary_email_address_id)?.email_address
        || u.email_addresses?.[0]?.email_address
        || '';
      const metadata = u.public_metadata || {};
      if (!isProUser(metadata)) continue;

      users.push({
        id: u.id,
        email,
        nombre: `${u.first_name || ''} ${u.last_name || ''}`.trim() || email.split('@')[0] || 'Usuario',
        metadata,
      });
    }

    if (batch.length < limit) break;
    offset += limit;
  }

  return users;
}

// ── Queries DuckDB ──────────────────────────────────────────────────────────
function getLastWeekDates(now = new Date()) {
  // Semana anterior: lunes a domingo. Si hoy es lunes, la semana que acaba de terminar.
  const day = now.getUTCDay(); // 0=domingo, 1=lunes...
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday - 1, 0, 0, 0, 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - 6, 0, 0, 0, 0));
  return { start, end };
}

async function queryTopCpvs(prefixes, startStr, endStr, limit = 5) {
  const hasPrefixes = prefixes.length > 0;

  let where = `fecha_publicacion >= '${startStr}' AND fecha_publicacion <= '${endStr}'`;
  where += " AND LOWER(estado) IN ('publicado', 'publicada', 'abierta', 'anuncio_previo', 'en curso', 'en curso ', 'evaluacion', 'evaluación', 'pendiente')";

  let cpvFilter = '';
  if (hasPrefixes) {
    const list = prefixes.map(p => `'${p}'`).join(',');
    cpvFilter = `AND SUBSTRING(cpv, 1, 5) IN (${list})`;
  }

  const sql = `
    SELECT
      id, fuente, organismo, objeto, cpv,
      importe_licitacion, fecha_publicacion, fecha_fin, estado, url
    FROM contratos_vivos
    WHERE ${where} ${cpvFilter}
    ORDER BY importe_licitacion DESC NULLS LAST
    LIMIT ${limit}
  `;

  return await queryLocalOrRest(sql);
}

async function queryOrganismosSeguidos(organismos, startStr, endStr, limit = 5) {
  if (!organismos.length) return [];

  const conditions = organismos.map(() => 'LOWER(organismo) LIKE ?').join(' OR ');
  const params = organismos.map(o => `%${o.nombre.toLowerCase()}%`);

  const sql = `
    SELECT
      organismo,
      COUNT(*)::INT AS n,
      SUM(importe_licitacion)::DOUBLE AS volumen
    FROM contratos_vivos
    WHERE fecha_publicacion >= '${startStr}'
      AND fecha_publicacion <= '${endStr}'
      AND (${conditions})
    GROUP BY organismo
    ORDER BY volumen DESC NULLS LAST
    LIMIT ${limit}
  `;

  return await queryLocalOrRest(sql, params);
}

async function queryContratosByOrganismo(organismo, startStr, endStr, limit = 3) {
  const sql = `
    SELECT
      id, fuente, organismo, objeto, importe_licitacion, importe_adjudicacion,
      fecha_publicacion, estado, url, adjudicatario, nif_adjudicatario
    FROM contratos_vivos
    WHERE fecha_publicacion >= '${startStr}'
      AND fecha_publicacion <= '${endStr}'
      AND LOWER(organismo) LIKE ?
    ORDER BY importe_licitacion DESC NULLS LAST
    LIMIT ${limit}
  `;
  return await queryLocalOrRest(sql, [`%${organismo.toLowerCase()}%`]);
}

function normalizeNif(nif) {
  return (nif || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

function canonName(name) {
  return (name || '')
    .replace(/,/g, '')
    .replace(/\./g, '')
    .replace(/\bS\.?L\.?U\.?\b/gi, '')
    .replace(/\bS\.?A\.?U\.?\b/gi, '')
    .replace(/\bS\.?L\.?\b/gi, '')
    .replace(/\bS\.?A\.?\b/gi, '')
    .replace(/\bS\.?C\.?\b/gi, '')
    .replace(/\bU\.?T\.?E\.?\b/gi, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function matchCompetidor(row, competidor) {
  const compNif = normalizeNif(competidor.nif);
  const rowNif = normalizeNif(row.nif_adjudicatario);
  if (compNif && rowNif && rowNif === compNif) return true;

  const compName = canonName(competidor.nombre);
  const rowName = canonName(row.adjudicatario);
  if (compName && rowName) {
    if (rowName === compName || rowName.includes(compName) || compName.includes(rowName)) return true;
  }
  return false;
}

async function queryCompetidoresSeguidos(competidores, startStr, endStr, limit = 5) {
  if (!competidores.length) return [];

  const sql = `
    SELECT
      id, fuente, organismo, objeto, adjudicatario, nif_adjudicatario,
      importe_adjudicacion, importe_licitacion, fecha_publicacion, estado, url
    FROM contratos_vivos
    WHERE fecha_publicacion >= '${startStr}'
      AND fecha_publicacion <= '${endStr}'
      AND LOWER(estado) IN ('adjudicada', 'adjudicado', 'formalizada', 'formalizado', 'resuelta', 'resuelto')
      AND (nif_adjudicatario IS NOT NULL OR adjudicatario IS NOT NULL)
    ORDER BY fecha_publicacion DESC
    LIMIT 500
  `;

  const rows = await queryLocalOrRest(sql);
  const matches = [];
  const seenIds = new Set();

  for (const r of rows) {
    for (const c of competidores) {
      if (matchCompetidor(r, c) && !seenIds.has(r.id)) {
        seenIds.add(r.id);
        matches.push({ ...r, competidor: c });
        break;
      }
    }
    if (matches.length >= limit) break;
  }

  return matches;
}

// ── F1.2: proveedores seguidos por NIF ─────────────────────────────────
// Adjudicaciones nuevas de la semana donde el NIF seguido aparece como
// adjudicatario (mismo criterio de estado que competidores). Agrupa por
// proveedor: [{ id, nombre, n, contratos: [...] }], n total y hasta
// maxContratos filas por proveedor.
function groupProveedoresRows(rows, proveedores, maxProveedores = 5, maxContratos = 3) {
  const byNif = new Map();
  for (const p of proveedores) {
    const nif = normalizeNif(p && p.id);
    if (nif && !byNif.has(nif)) {
      byNif.set(nif, { id: p.id, nombre: p.nombre || p.id, n: 0, contratos: [] });
    }
  }
  for (const r of rows || []) {
    const entry = byNif.get(normalizeNif(r.nif_adjudicatario));
    if (!entry) continue;
    entry.n++;
    if (entry.contratos.length < maxContratos) entry.contratos.push(r);
  }
  return [...byNif.values()].filter(e => e.contratos.length > 0).slice(0, maxProveedores);
}

async function queryProveedoresSeguidos(proveedores, startStr, endStr, limit = 5) {
  if (!proveedores.length) return [];
  const nifs = [...new Set(proveedores.map(p => normalizeNif(p && p.id)).filter(Boolean))];
  if (!nifs.length) return [];

  const conditions = nifs.map(() => 'UPPER(nif_adjudicatario) = ?').join(' OR ');
  const sql = `
    SELECT
      id, fuente, organismo, objeto, adjudicatario, nif_adjudicatario,
      importe_adjudicacion, importe_licitacion, fecha_publicacion, estado, url
    FROM contratos_vivos
    WHERE fecha_publicacion >= '${startStr}'
      AND fecha_publicacion <= '${endStr}'
      AND (${conditions})
      AND LOWER(estado) IN ('adjudicada', 'adjudicado', 'formalizada', 'formalizado', 'resuelta', 'resuelto')
    ORDER BY fecha_publicacion DESC
    LIMIT 300
  `;

  const rows = await queryLocalOrRest(sql, nifs);
  return groupProveedoresRows(rows, proveedores, limit, 3);
}

async function queryResumenMercado(prefixes, startStr, endStr) {
  const hasPrefixes = prefixes.length > 0;
  const list = hasPrefixes ? prefixes.map(p => `'${p}'`).join(',') : '';

  const cpvFilter = hasPrefixes
    ? `AND SUBSTRING(cpv, 1, 5) IN (${list})`
    : '';

  const totalSql = `
    SELECT
      COUNT(*)::INT AS n,
      SUM(importe_licitacion)::DOUBLE AS volumen
    FROM contratos_vivos
    WHERE fecha_publicacion >= '${startStr}'
      AND fecha_publicacion <= '${endStr}'
      ${cpvFilter}
  `;

  const ccaaSql = `
    SELECT fuente, COUNT(*)::INT AS n, SUM(importe_licitacion)::DOUBLE AS volumen
    FROM contratos_vivos
    WHERE fecha_publicacion >= '${startStr}'
      AND fecha_publicacion <= '${endStr}'
      ${cpvFilter}
    GROUP BY fuente
    ORDER BY n DESC
    LIMIT 5
  `;

  const [totales, ccaa] = await Promise.all([queryLocalOrRest(totalSql), queryLocalOrRest(ccaaSql)]);
  return {
    total: totales[0]?.n || 0,
    volumen: totales[0]?.volumen || 0,
    ccaa: ccaa.map(r => ({ fuente: r.fuente, n: r.n, volumen: r.volumen })),
  };
}

// ── Resumen genérico (cuando no hay follows ni CPVs) ────────────────────────
async function queryResumenGenerico(startStr, endStr) {
  const topSql = `
    SELECT id, fuente, organismo, objeto, cpv, importe_licitacion, fecha_publicacion, url
    FROM contratos_vivos
    WHERE fecha_publicacion >= '${startStr}'
      AND fecha_publicacion <= '${endStr}'
    ORDER BY importe_licitacion DESC NULLS LAST
    LIMIT 5
  `;

  const [top, mercado] = await Promise.all([
    queryLocalOrRest(topSql),
    queryResumenMercado([], startStr, endStr),
  ]);

  return { top, mercado };
}

// ── Email HTML (tema claro email-safe) + texto plano ────────────────────────
// Muchos clientes (Gmail/Outlook web, lectores en texto) ignoran o eliminan el
// fondo del body: un email oscuro con texto claro se queda en blanco sobre
// blanco. Tema claro con colores sólidos, tablas anidadas y fuentes de sistema.
const FONT_SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const FONT_MONO = "'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace";

function sectionTitle(title) {
  return `
      <h2 style="margin:28px 0 10px;font-size:15px;font-weight:700;color:#18181b;border-left:3px solid #059669;padding-left:10px;line-height:1.3;font-family:${FONT_SANS}">
        ${escapeHtml(title)}
      </h2>
  `;
}

function emptyState(text) {
  return `<p style="color:#a1a1aa;font-size:13px;padding:8px 0 0;margin:0;font-family:${FONT_SANS}">${escapeHtml(text)}</p>`;
}

function buildEmailHTML({ nombre, fechaRango, topCpvs, organismos, competidores, proveedores, bormeActos, mercado, hasConfig }) {
  const proveedoresList = Array.isArray(proveedores) ? proveedores : [];
  const bormeList = Array.isArray(bormeActos) ? bormeActos : [];
  const sectorLabel = hasConfig ? 'tu sector' : 'el mercado';
  const preheader = `${mercado.total.toLocaleString('es-ES')} licitaciones · ${formatImporte(mercado.volumen)} de volumen · lo más relevante de ${sectorLabel}`;

  let topRows;
  if (topCpvs.length === 0) {
    topRows = emptyState('No hemos detectado licitaciones nuevas en tus CPVs esta semana.');
  } else {
    topRows = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${topCpvs.map(c => `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #e4e4e7;vertical-align:top">
            <a href="${escapeHtml(buildLicitacionLink(c.id, c.url))}" style="color:#18181b;text-decoration:none;font-size:15px;font-weight:600;line-height:1.4;display:block;margin-bottom:5px;font-family:${FONT_SANS}">
              ${escapeHtml((c.objeto || 'Sin título').slice(0, 120))}
            </a>
            <div style="font-size:13px;color:#52525b;margin-bottom:5px;font-family:${FONT_SANS}">${escapeHtml((c.organismo || 'Organismo no disponible').slice(0, 80))}</div>
            <div style="font-family:${FONT_MONO};font-size:12px;color:#71717a">
              <span style="color:#059669;font-weight:700">${formatImporte(c.importe_licitacion)}</span>${c.fecha_publicacion ? ` · Publicado: ${String(c.fecha_publicacion).slice(0, 10)}` : ''}${c.cpv ? ` · CPV: ${escapeHtml(String(c.cpv).slice(0, 12))}` : ''}
            </div>
          </td>
        </tr>`).join('')}</table>`;
  }

  let organismosRows;
  if (organismos.length === 0) {
    organismosRows = emptyState('No hay actividad nueva en los organismos que sigues esta semana.');
  } else {
    organismosRows = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${organismos.map(o => `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #e4e4e7;vertical-align:top">
            <div style="font-size:14px;font-weight:600;color:#18181b;margin-bottom:6px;font-family:${FONT_SANS}">
              ${escapeHtml(o.nombre)}
              <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#ecfdf5;color:#059669;font-size:11px;font-weight:700;font-family:${FONT_MONO}">${o.n} nuevo${o.n !== 1 ? 's' : ''}</span>
            </div>
            ${o.contratos.map(c => `
              <div style="margin:5px 0 0 12px;font-size:13px;color:#52525b;line-height:1.45;font-family:${FONT_SANS}">
                · <a href="${escapeHtml(buildLicitacionLink(c.id, c.url))}" style="color:#3f3f46;text-decoration:none">${escapeHtml((c.objeto || 'Sin título').slice(0, 90))}</a>
                <span style="color:#059669;font-family:${FONT_MONO};font-size:12px;margin-left:6px">${formatImporte(c.importe_licitacion)}</span>
              </div>`).join('')}
          </td>
        </tr>`).join('')}</table>`;
  }

  let competidoresRows;
  if (competidores.length === 0) {
    competidoresRows = emptyState('Tus competidores no han aparecido como adjudicatarios esta semana.');
  } else {
    competidoresRows = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${competidores.map(c => `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #e4e4e7;vertical-align:top">
            <div style="font-size:12px;font-weight:700;color:#059669;font-family:${FONT_MONO};margin-bottom:5px">
              ${escapeHtml(c.competidor.nombre)}${c.competidor.nif ? ` <span style="color:#a1a1aa;font-weight:400">${escapeHtml(c.competidor.nif)}</span>` : ''}
            </div>
            <a href="${escapeHtml(buildLicitacionLink(c.id, c.url))}" style="color:#18181b;text-decoration:none;font-size:15px;font-weight:600;line-height:1.4;display:block;margin-bottom:5px;font-family:${FONT_SANS}">
              ${escapeHtml((c.objeto || 'Sin título').slice(0, 110))}
            </a>
            <div style="font-family:${FONT_MONO};font-size:12px;color:#71717a">
              ${escapeHtml((c.organismo || '').slice(0, 70))}<br>
              Importe adjudicado: <span style="color:#059669;font-weight:700">${formatImporte(c.importe_adjudicacion)}</span>${c.fecha_publicacion ? ` · Publicado: ${String(c.fecha_publicacion).slice(0, 10)}` : ''}
            </div>
          </td>
        </tr>`).join('')}</table>`;
  }

  let proveedoresRows;
  if (proveedoresList.length === 0) {
    proveedoresRows = emptyState(bormeList.length
      ? 'Sin adjudicaciones nuevas esta semana en tus perfiles seguidos.'
      : 'No sigues ningún perfil de proveedor todavía. Descúbrelos desde los perfiles públicos de elicita.');
  } else {
    proveedoresRows = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${proveedoresList.map(p => `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #e4e4e7;vertical-align:top">
            <div style="font-size:14px;font-weight:600;color:#18181b;margin-bottom:6px;font-family:${FONT_SANS}">
              ${escapeHtml(p.nombre)}${p.id ? ` <span style="color:#a1a1aa;font-weight:400;font-size:12px;font-family:${FONT_MONO}">${escapeHtml(p.id)}</span>` : ''}
              <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#ecfdf5;color:#059669;font-size:11px;font-weight:700;font-family:${FONT_MONO}">${p.n} adjudicaci${p.n === 1 ? 'ón nueva' : 'ones nuevas'}</span>
            </div>
            ${p.contratos.map(c => `
              <div style="margin:5px 0 0 12px;font-size:13px;color:#52525b;line-height:1.45;font-family:${FONT_SANS}">
                · <a href="${escapeHtml(buildLicitacionLink(c.id, c.url))}" style="color:#3f3f46;text-decoration:none">${escapeHtml((c.objeto || 'Sin título').slice(0, 90))}</a>
                <span style="color:#059669;font-family:${FONT_MONO};font-size:12px;margin-left:6px">${formatImporte(c.importe_adjudicacion)}</span>
              </div>`).join('')}
          </td>
        </tr>`).join('')}</table>`;
  }

  // Fase 2 plan BORME: actos registrales de la semana por perfil seguido.
  let bormeRows;
  if (bormeList.length === 0) {
    bormeRows = '';
  } else {
    bormeRows = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bormeList.map(b => `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #e4e4e7;vertical-align:top">
            <div style="font-size:14px;font-weight:600;color:#18181b;margin-bottom:6px;font-family:${FONT_SANS}">
              ${escapeHtml(b.nombre)}${b.nif ? ` <span style="color:#a1a1aa;font-weight:400;font-size:12px;font-family:${FONT_MONO}">${escapeHtml(b.nif)}</span>` : ''}
              <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#eff6ff;color:#1d4ed8;font-size:11px;font-weight:700;font-family:${FONT_MONO}">Registro mercantil</span>
            </div>
            ${groupActosByDate(b.actos).map(g => `
              <div style="margin:5px 0 0 12px;font-size:13px;color:#52525b;line-height:1.45;font-family:${FONT_SANS}">
                · <span style="font-family:${FONT_MONO};color:#71717a">${g.fecha}</span> — ${escapeHtml(g.actos.join(' · '))}${g.pdfUrl ? ` <a href="${escapeHtml(g.pdfUrl)}" style="color:#059669;text-decoration:none;font-family:${FONT_MONO};font-size:11px">PDF ↗</a>` : ''}
              </div>`).join('')}
            <div style="margin:6px 0 0 12px;font-size:12px;font-family:${FONT_SANS}">
              <a href="${ELICITA_URL}/perfil/${encodeURIComponent(b.nif)}" style="color:#059669;text-decoration:none">Ver ficha completa →</a>
            </div>
          </td>
        </tr>`).join('')}</table>`;
  }

  const ccaaRows = mercado.ccaa.length === 0
    ? emptyState('No hay datos suficientes para el desglose por CCAA esta semana.')
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${mercado.ccaa.map((r, i) => `
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid #f4f4f5;font-size:13px;color:#3f3f46;font-family:${FONT_SANS}">${i + 1}. ${escapeHtml(r.fuente)}</td>
          <td style="padding:9px 0;border-bottom:1px solid #f4f4f5;font-size:12px;color:#71717a;text-align:right;font-family:${FONT_MONO};white-space:nowrap">${r.n} contrato${r.n !== 1 ? 's' : ''}</td>
          <td style="padding:9px 0;border-bottom:1px solid #f4f4f5;font-size:12px;color:#059669;text-align:right;font-family:${FONT_MONO};font-weight:700;white-space:nowrap">${formatImporte(r.volumen)}</td>
        </tr>`).join('')}</table>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f4f5">
  <div style="display:none;font-size:1px;color:#f4f4f5;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f4f5" style="background:#f4f4f5">
    <tr>
      <td align="center" style="padding:28px 12px">
        <table role="presentation" width="620" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px">
          <tr>
            <td style="padding:30px 28px 0">
              <div style="font-family:${FONT_MONO};font-size:15px;color:#059669;font-weight:700">elicita_</div>
              <h1 style="margin:12px 0 0;font-size:21px;font-weight:700;color:#18181b;line-height:1.3;font-family:${FONT_SANS}">Tu resumen semanal de contratación pública</h1>
              <p style="margin:6px 0 0;font-size:13px;color:#71717a;font-family:${FONT_SANS}">Semana del ${escapeHtml(fechaRango)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f0fdf4" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
                <tr><td style="padding:14px 16px;font-size:14px;color:#1f2937;line-height:1.55;font-family:${FONT_SANS}">
                  Hola${nombre ? `, <strong>${escapeHtml(nombre)}</strong>` : ''}. Esta semana hemos rastreado <strong style="color:#059669">${mercado.total.toLocaleString('es-ES')}</strong> licitaciones en ${sectorLabel} con un volumen total de <strong style="color:#059669">${formatImporte(mercado.volumen)}</strong>.
                </td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 8px">
              ${sectionTitle(hasConfig ? '5 licitaciones más relevantes para tu perfil' : '5 licitaciones más relevantes del mercado')}
              ${topRows}
              ${sectionTitle('Actividad en organismos que sigues')}
              ${organismosRows}
              ${sectionTitle('Tus competidores han ganado')}
              ${competidoresRows}
              ${sectionTitle('Actividad de tus perfiles seguidos')}
              ${proveedoresRows}
              ${bormeRows}
              ${sectionTitle('Resumen del mercado')}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">
                <tr>
                  <td width="50%" style="padding-right:5px">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fafafa" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:8px">
                      <tr><td style="padding:14px 16px">
                        <div style="font-size:11px;color:#71717a;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;font-family:${FONT_SANS}">Total licitaciones</div>
                        <div style="font-size:22px;font-weight:700;color:#059669;font-family:${FONT_MONO}">${mercado.total.toLocaleString('es-ES')}</div>
                      </td></tr>
                    </table>
                  </td>
                  <td width="50%" style="padding-left:5px">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fafafa" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:8px">
                      <tr><td style="padding:14px 16px">
                        <div style="font-size:11px;color:#71717a;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;font-family:${FONT_SANS}">Volumen total</div>
                        <div style="font-size:22px;font-weight:700;color:#059669;font-family:${FONT_MONO}">${formatImporte(mercado.volumen)}</div>
                      </td></tr>
                    </table>
                  </td>
                </tr>
              </table>
              <p style="font-size:13px;color:#52525b;margin:18px 0 8px;font-family:${FONT_SANS}">CCAA con más actividad:</p>
              ${ccaaRows}
            </td>
          </tr>
          <tr>
            <td style="padding:26px 28px 30px" align="center">
              <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                <tr>
                  <td bgcolor="#059669" style="border-radius:6px">
                    <a href="${buildExplorerUrl()}" style="display:inline-block;background:#059669;color:#ffffff;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;font-family:${FONT_SANS}">Explorar licitaciones →</a>
                  </td>
                  <td width="10">&nbsp;</td>
                  <td bgcolor="#ffffff" style="border-radius:6px;border:1px solid #d4d4d8">
                    <a href="${ELICITA_URL}/cuenta/alertas" style="display:inline-block;background:#ffffff;color:#3f3f46;padding:12px 20px;border-radius:6px;font-size:14px;font-weight:500;text-decoration:none;font-family:${FONT_SANS}">Ajustar alertas</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%">
          <tr><td style="padding:20px 12px;font-size:11px;color:#a1a1aa;text-align:center;line-height:1.6;font-family:${FONT_SANS}">
            Elicita — Inteligencia sobre contratación pública<br>
            <a href="${ELICITA_URL}/cuenta" style="color:#a1a1aa;text-decoration:underline">Gestionar cuenta</a> ·
            <a href="${ELICITA_URL}/cuenta/alertas" style="color:#a1a1aa;text-decoration:underline">Preferencias de alertas</a>
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildEmailText({ nombre, fechaRango, topCpvs, organismos, competidores, proveedores, bormeActos, mercado, hasConfig }) {
  const proveedoresList = Array.isArray(proveedores) ? proveedores : [];
  const bormeList = Array.isArray(bormeActos) ? bormeActos : [];
  const sectorLabel = hasConfig ? 'tu sector' : 'el mercado';
  const L = [];
  L.push('ELICITA — Tu resumen semanal de contratación pública');
  L.push(`Semana del ${fechaRango}`);
  L.push('');
  L.push(`Hola${nombre ? `, ${nombre}` : ''}. Esta semana hemos rastreado ${mercado.total.toLocaleString('es-ES')} licitaciones en ${sectorLabel} con un volumen total de ${formatImporte(mercado.volumen)}.`);
  L.push('');
  L.push(hasConfig ? '5 LICITACIONES MÁS RELEVANTES PARA TU PERFIL' : '5 LICITACIONES MÁS RELEVANTES DEL MERCADO');
  if (topCpvs.length === 0) {
    L.push('No hemos detectado licitaciones nuevas en tus CPVs esta semana.');
  } else {
    topCpvs.forEach((c, i) => {
      L.push(`${i + 1}. ${c.objeto || 'Sin título'}`);
      L.push(`   ${c.organismo || 'Organismo no disponible'} · Importe: ${formatImporte(c.importe_licitacion)}${c.fecha_publicacion ? ` · Publicado: ${String(c.fecha_publicacion).slice(0, 10)}` : ''}`);
      L.push(`   ${buildLicitacionLink(c.id, c.url)}`);
    });
  }
  L.push('');
  L.push('ACTIVIDAD EN ORGANISMOS QUE SIGUES');
  if (organismos.length === 0) {
    L.push('No hay actividad nueva en los organismos que sigues esta semana.');
  } else {
    for (const o of organismos) {
      L.push(`· ${o.nombre} (${o.n} nuevo${o.n !== 1 ? 's' : ''})`);
      for (const c of o.contratos) {
        L.push(`  - ${c.objeto || 'Sin título'} · ${formatImporte(c.importe_licitacion)}`);
        L.push(`    ${buildLicitacionLink(c.id, c.url)}`);
      }
    }
  }
  L.push('');
  L.push('TUS COMPETIDORES HAN GANADO');
  if (competidores.length === 0) {
    L.push('Tus competidores no han aparecido como adjudicatarios esta semana.');
  } else {
    for (const c of competidores) {
      L.push(`· ${c.competidor.nombre}${c.competidor.nif ? ` (${c.competidor.nif})` : ''}`);
      L.push(`  ${c.objeto || 'Sin título'} · Importe adjudicado: ${formatImporte(c.importe_adjudicacion)}`);
      L.push(`  ${buildLicitacionLink(c.id, c.url)}`);
    }
  }
  L.push('');
  L.push('ACTIVIDAD DE TUS PERFILES SEGUIDOS');
  if (proveedoresList.length === 0) {
    L.push(bormeList.length
      ? 'Sin adjudicaciones nuevas esta semana en tus perfiles seguidos.'
      : 'No sigues ningún perfil de proveedor todavía.');
  } else {
    for (const p of proveedoresList) {
      L.push(`· ${p.nombre}${p.id ? ` (${p.id})` : ''} (${p.n} adjudicaci${p.n === 1 ? 'ón nueva' : 'ones nuevas'})`);
      for (const c of p.contratos) {
        L.push(`  - ${c.objeto || 'Sin título'} · Importe adjudicado: ${formatImporte(c.importe_adjudicacion)}`);
        L.push(`    ${buildLicitacionLink(c.id, c.url)}`);
      }
    }
  }
  // Fase 2 plan BORME: actos registrales de la semana por perfil seguido.
  for (const b of bormeList) {
    L.push(`· Registro mercantil (BORME) — ${b.nombre}${b.nif ? ` (${b.nif})` : ''}`);
    for (const g of groupActosByDate(b.actos)) {
      L.push(`    - ${g.fecha} · ${g.actos.join(' · ')}`);
      if (g.pdfUrl) L.push(`      Boletín: ${g.pdfUrl}`);
    }
    L.push(`    Ficha: ${ELICITA_URL}/perfil/${b.nif}`);
  }
  L.push('');
  L.push('RESUMEN DEL MERCADO');
  L.push(`Total licitaciones: ${mercado.total.toLocaleString('es-ES')}`);
  L.push(`Volumen total: ${formatImporte(mercado.volumen)}`);
  if (mercado.ccaa.length > 0) {
    L.push('CCAA con más actividad:');
    mercado.ccaa.forEach((r, i) => L.push(`${i + 1}. ${r.fuente} — ${r.n} contratos · ${formatImporte(r.volumen)}`));
  }
  L.push('');
  L.push(`Explorar: ${buildExplorerUrl()}`);
  L.push(`Ajustar alertas: ${ELICITA_URL}/cuenta/alertas`);
  L.push('');
  L.push('Elicita — Inteligencia sobre contratación pública');
  return L.join('\n');
}

// ── Envío de email ───────────────────────────────────────────────────────────
async function sendEmail(to, subject, html, text) {
  if (!_RESEND_KEY) throw new Error('RESEND_API_KEY no configurada');

  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${_RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: _FROM_EMAIL,
        to: [to],
        subject,
        html,
        ...(text ? { text } : {}),
      }),
    });
  } catch (e) {
    const causa = e.cause?.code || e.cause?.message || e.message;
    throw new Error(`fetch a Resend falló: ${causa}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend error ${res.status}: ${text}`);
  }

  return await res.json();
}

// ── Construir reporte para un usuario ──────────────────────────────────────
async function buildReportForUser(user, startStr, endStr, fechaRango) {
  const alertas = user.metadata?.alertas || {};
  const follows = user.metadata?.follows || {};
  const organismos = Array.isArray(follows.organismos) ? follows.organismos : [];
  const competidores = Array.isArray(follows.competidores) ? follows.competidores : [];
  // F1.2: proveedores seguidos por NIF ({ id: NIF, nombre, createdAt })
  const proveedores = Array.isArray(follows.proveedores) ? follows.proveedores : [];
  const cpvs = getCpvPrefixes(alertas.cpvs || []);

  const hasConfig = organismos.length > 0 || competidores.length > 0 || proveedores.length > 0 || cpvs.length > 0;

  // Si no tiene configuración, usamos resumen genérico del mercado
  let topCpvs = [];
  let organismosData = [];
  let competidoresData = [];
  let proveedoresData = [];
  let mercado;

  if (!hasConfig) {
    const generico = await queryResumenGenerico(startStr, endStr);
    topCpvs = generico.top;
    mercado = generico.mercado;
  } else {
    [topCpvs, organismosData, competidoresData, proveedoresData, mercado] = await Promise.all([
      queryTopCpvs(cpvs, startStr, endStr, 5),
      queryOrganismosSeguidos(organismos, startStr, endStr, 5),
      queryCompetidoresSeguidos(competidores, startStr, endStr, 5),
      queryProveedoresSeguidos(proveedores, startStr, endStr, 5),
      queryResumenMercado(cpvs, startStr, endStr),
    ]);

    // Cargar contratos representativos por organismo seguido
    const organismoConContratos = [];
    for (const o of organismosData) {
      const contratos = await queryContratosByOrganismo(o.organismo, startStr, endStr, 3);
      organismoConContratos.push({
        nombre: o.organismo,
        n: o.n,
        volumen: o.volumen,
        contratos,
      });
    }
    organismosData = organismoConContratos;
  }

  // Si no hay top CPVs pero hay mercado, rellenar con top genérico
  if (topCpvs.length === 0 && hasConfig) {
    const generico = await queryResumenGenerico(startStr, endStr);
    topCpvs = generico.top;
  }

  // Fase 2 plan BORME (2026-10-14): actos registrales de la semana para los
  // NIF seguidos (misma resolución que /perfil: nif_canonical → clave exacta).
  let bormeActos = [];
  if (proveedores.length) {
    try {
      bormeActos = await queryBormeActosSeguidos(queryLocalOrRest, proveedores, startStr, endStr);
    } catch (e) {
      log(`[BORME] actos registrales no disponibles: ${e.message}`);
    }
  }

  const emailData = {
    nombre: user.nombre,
    fechaRango,
    topCpvs,
    organismos: organismosData,
    competidores: competidoresData,
    proveedores: proveedoresData,
    bormeActos,
    mercado,
    hasConfig,
  };
  const html = buildEmailHTML(emailData);
  const text = buildEmailText(emailData);

  const subject = 'Tu resumen semanal de contratación pública — Elicita';

  return { html, text, subject, topCpvs, organismos: organismosData, competidores: competidoresData, proveedores: proveedoresData, bormeActos, mercado };
}

// ── Entry points ─────────────────────────────────────────────────────────────
async function runReporteSemanal({ dryRun = false, onlyUser = null } = {}) {
  // Reintentar DuckDB local en cada ejecución; el fallback REST es puntual, no permanente.
  useRestFallback = false;
  log(`Iniciando reporte semanal | dryRun=${dryRun} | onlyUser=${onlyUser || 'all'}`);

  const { start, end } = getLastWeekDates();
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  const fechaRango = formatDateRange(start, end);

  log(`Semana objetivo: ${startStr} → ${endStr}`);

  await initDb();

  let users;
  try {
    users = await fetchClerkUsers();
  } catch (e) {
    log(`[ERROR] No se pudo obtener usuarios Pro: ${e.message}`);
    closeDb();
    throw e;
  }

  log(`Usuarios Pro encontrados: ${users.length}`);

  if (onlyUser) {
    users = users.filter(u => u.id === onlyUser || u.email === onlyUser);
    log(`Filtrado a ${users.length} usuario(s)`);
  }

  const resultados = {
    start: startStr,
    end: endStr,
    total: users.length,
    enviados: 0,
    errores: 0,
    dryRun,
    detalles: [],
  };

  for (const user of users) {
    const detail = { userId: user.id, email: user.email, ok: false, error: null };
    try {
      const report = await buildReportForUser(user, startStr, endStr, fechaRango);

      if (dryRun) {
        if (process.env.REPORT_DUMP_HTML) fs.writeFileSync(process.env.REPORT_DUMP_HTML, report.html);
        if (process.env.REPORT_DUMP_TEXT) fs.writeFileSync(process.env.REPORT_DUMP_TEXT, report.text);
        log(`[DRY-RUN] ${user.email} — top=${report.topCpvs.length} orgs=${report.organismos.length} comps=${report.competidores.length} proves=${(report.proveedores || []).length}`);
        detail.ok = true;
        detail.resumen = {
          topCpvs: report.topCpvs.length,
          organismos: report.organismos.length,
          competidores: report.competidores.length,
          proveedores: (report.proveedores || []).length,
          totalMercado: report.mercado.total,
        };
        resultados.enviados++;
      } else {
        await sendEmail(user.email, report.subject, report.html, report.text);
        log(`[OK] Enviado a ${user.email}`);
        detail.ok = true;
        detail.resumen = {
          topCpvs: report.topCpvs.length,
          organismos: report.organismos.length,
          competidores: report.competidores.length,
          proveedores: (report.proveedores || []).length,
          totalMercado: report.mercado.total,
        };
        resultados.enviados++;
      }
    } catch (e) {
      log(`[ERROR] ${user.email}: ${e.message}`);
      detail.error = e.message;
      resultados.errores++;
    }
    resultados.detalles.push(detail);
  }

  closeDb();
  log(`Reporte semanal finalizado | enviados=${resultados.enviados} errores=${resultados.errores}`);
  return resultados;
}

// CLI
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const onlyUser = process.argv.find((arg, i) => i > 1 && arg.includes('@') || arg.startsWith('user_')) || process.env.REPORTE_ONLY_USER;

  runReporteSemanal({ dryRun, onlyUser })
    .then(r => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch(e => {
      log(`[FATAL] ${e.message}`);
      console.error(e);
      process.exit(1);
    });
}

module.exports = {
  runReporteSemanal,
  getLastWeekDates,
  buildReportForUser,
  queryProveedoresSeguidos,
  groupProveedoresRows,
  normalizeNif,
  initDb,
  closeDb,
  setRestFallback: (v) => { useRestFallback = v; },
};
