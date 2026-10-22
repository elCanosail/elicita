/**
 * Alertas Runner — Elicita
 * ═══════════════════════════════════════════════════════════════════
 *
 * Revisa alertas configuradas por cada usuario en Clerk, busca
 * licitaciones nuevas en DuckDB que coincidan, y envía un email
 * diario/4h con Resend.
 *
 * - Se ejecuta desde el scheduler cada 4 horas (minuto 30, cada 4h).
 * - También puede correr standalone: node ingesta/alertas-runner.js
 * - Log: ingesta/logs/alertas.log
 * - Estado por usuario: publicMetadata.alertas.ultima_revision (YYYY-MM-DD)
 *
 * Nota sobre deduplicación: DuckDB guarda fecha_publicacion como DATE.
 * La marca última_revision es una fecha, por lo que en frecuencia 4h
 * pueden repetirse contratos publicados el mismo día. Para minimizar
 * duplicados, la query devuelve los 50 más recientes ordenados por fecha.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

// ── Config ────────────────────────────────────────────────────────────────
const BASE_DIR = __dirname;
const WEB_DIR = path.join(BASE_DIR, '..', 'web');
const LOG_FILE = path.join(BASE_DIR, 'logs', 'alertas.log');
const MAX_LOG_SIZE = 50 * 1024 * 1024; // rotate at 50MB
const MAX_RESULTS = 50;
const RESEND_RATE_LIMIT_MS = 500; // 2 emails/segundo
const CLERK_PAGE_LIMIT = 100;
const FROM_EMAIL = 'alertas@elicita.es';
const FROM_NAME = 'Elicita';
const ELICITA_URL = process.env.ELICITA_URL || 'https://elicita.es';

// ── Cargar .env de web/ si faltan variables ──────────────────────────────
function loadEnv() {
  if (process.env.CLERK_SECRET_KEY && process.env.RESEND_API_KEY) return;

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

// ── DuckDB (con fallback REST) ──────────────────────────────────────────────
const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
const WEB_HEALTH_URL = process.env.WEB_HEALTH_URL || 'http://127.0.0.1:4321/api/health';
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

async function queryRest(sql) {
  const url = `${ELICITA_API_URL}/api/admin/duckdb-query`;
  try {
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
  } catch (e) {
    if (e.cause?.code === 'ECONNRESET' || e.code === 'ECONNRESET' || e.message?.includes('fetch failed')) {
      return queryRestHttp(sql);
    }
    throw e;
  }
}

function queryRestHttp(sql) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const url = new URL(`${ELICITA_API_URL}/api/admin/duckdb-query`);
    const data = JSON.stringify({ sql });
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { ...restHeaders(), 'Content-Length': Buffer.byteLength(data) },
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
          const parsed = JSON.parse(body);
          if (!Array.isArray(parsed.rows)) throw new Error('Respuesta inesperada');
          resolve(parsed.rows);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function query(sql, params = []) {
  if (useRestFallback) {
    // REST endpoint no soporta prepared statements — interpolar parámetros manualmente
    let interpolated = sql;
    let idx = 0;
    interpolated = interpolated.replace(/\?/g, () => {
      const p = params[idx++];
      if (p === null || p === undefined) return 'NULL';
      if (typeof p === 'number') return String(p);
      // String: escapar comillas simples
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
    // Reintentar con interpolación
    let interpolated = sql;
    let idx = 0;
    interpolated = interpolated.replace(/\?/g, () => {
      const p = params[idx++];
      if (p === null || p === undefined) return 'NULL';
      if (typeof p === 'number') return String(p);
      return "'" + String(p).replace(/'/g, "''") + "'";
    });
    return queryRest(interpolated);
  }
}

// ── Clerk helpers ─────────────────────────────────────────────────────────
async function* listUsersWithAlertas() {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) {
    log('CLERK_SECRET_KEY no configurada — no se listan usuarios');
    return;
  }

  let offset = 0;
  while (true) {
    const url = `https://api.clerk.com/v1/users?limit=${CLERK_PAGE_LIMIT}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Clerk API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const users = Array.isArray(data) ? data : (data.data || []);

    for (const user of users) {
      const alertas = user.public_metadata?.alertas;
      if (alertas && alertas.activo !== false) {
        yield user;
      }
    }

    if (users.length < CLERK_PAGE_LIMIT) break;
    offset += CLERK_PAGE_LIMIT;
  }
}

function getPrimaryVerifiedEmail(user) {
  const emails = user.email_addresses || [];
  const primary = emails.find((e) => e.id === user.primary_email_address_id) || emails[0];
  if (!primary) return null;
  if (primary.verification && primary.verification.status !== 'verified') return null;
  return primary.email_address || null;
}

// ── Plan / límites ──────────────────────────────────────────────────────────
function resolvePlan(metadata) {
  const raw = metadata?.plan;
  if (raw === 'empresa') return 'empresa';
  if (raw === 'pro' || raw === 'inteligencia' || raw === 'monitor' || raw === 'operador' || raw === 'starter') return 'pro';
  if (raw === 'developer') return 'developer';
  return 'free';
}

function getMaxAlerts(plan) {
  if (plan === 'pro' || plan === 'empresa') return Infinity;
  if (plan === 'developer') return 0;
  return 1;
}

function countAlertFields(alertas) {
  return [alertas.cpvs, alertas.organismos, alertas.keywords].filter((arr) => Array.isArray(arr) && arr.length > 0).length;
}

function isAdmin(user) {
  const ADMIN_USERNAMES = ['admin'];
  const ADMIN_IDS = [
    
    
  ];
  return ADMIN_USERNAMES.includes(user.username || '') || ADMIN_IDS.includes(user.id);
}

// ── Query builder ──────────────────────────────────────────────────────────
function getCpvPrefixes(cpvs) {
  return (cpvs || [])
    .map((c) => String(c).replace('.0', '').trim().replace(/\s+/g, '').slice(0, 5))
    .filter((c) => /^\d{5}$/.test(c));
}

async function findContratos(alertas, ultimaRevision, externalQuery = null) {
  const conditions = [];
  const params = [];

  // Solo licitaciones abiertas/publicadas recientemente
  conditions.push(`LOWER(estado) IN ('abierta','publicada','publicado','anuncio_previo','anuncio previo','en evaluacion','evaluacion','en_curso','activo','pendiente')`);

  // Fecha desde última revisión (fallback a ayer)
  const since = ultimaRevision || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  conditions.push('fecha_publicacion >= ?');
  params.push(since);

  // CPV: coincidencia por prefijo de 5 dígitos
  const prefixes = getCpvPrefixes(alertas.cpvs);
  if (prefixes.length > 0) {
    const placeholders = prefixes.map(() => '?').join(',');
    conditions.push(`SUBSTRING(REPLACE(REPLACE(cpv, '.0', ''), ' ', ''), 1, 5) IN (${placeholders})`);
    params.push(...prefixes);
  }

  // Organismos: LIKE parcial (case-insensitive)
  if (alertas.organismos?.length > 0) {
    const orgs = alertas.organismos.filter((o) => String(o).trim().length > 0);
    if (orgs.length > 0) {
      conditions.push(`(${orgs.map(() => 'LOWER(organismo) LIKE ?').join(' OR ')})`);
      params.push(...orgs.map((o) => `%${String(o).toLowerCase()}%`));
    }
  }

  // Keywords: OR entre keywords, AND entre términos de cada keyword
  if (alertas.keywords?.length > 0) {
    const keywordBlocks = alertas.keywords
      .map((kw) => {
        const terms = String(kw)
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 1);
        if (terms.length === 0) return null;
        return terms
          .map((term) => {
            params.push(`%${term}%`, `%${term}%`);
            return '(LOWER(objeto) LIKE ? OR LOWER(organismo) LIKE ?)';
          })
          .join(' AND ');
      })
      .filter(Boolean);

    if (keywordBlocks.length > 0) {
      conditions.push(`(${keywordBlocks.map((b) => `(${b})`).join(' OR ')})`);
    }
  }

  if (conditions.length === 0) return [];

  const where = `WHERE ${conditions.join(' AND ')}`;
  const sql = `
    SELECT
      id,
      fuente,
      organismo,
      objeto,
      cpv,
      importe_licitacion,
      importe_adjudicacion,
      fecha_publicacion,
      estado
    FROM contratos_vivos
    ${where}
    ORDER BY fecha_publicacion DESC, id DESC
    LIMIT ${MAX_RESULTS}
  `;

  if (externalQuery) return externalQuery(sql, params);
  return query(sql, params);
}

// ── Formatting ──────────────────────────────────────────────────────────────
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
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linkContrato(fuente, id) {
  const safeFuente = encodeURIComponent(String(fuente || 'unknown'));
  const safeId = encodeURIComponent(String(id || ''));
  return `${ELICITA_URL}/licitacion/${safeFuente}/${safeId}`;
}

function buildEmailHTML({ nombre, contratos, alertCount, frecuencia }) {
  const rows = contratos
    .map(
      (c) => `
    <tr>
      <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top;">
        <a href="${escapeHtml(linkContrato(c.fuente, c.id))}" style="color:#059669;text-decoration:none;font-size:14px;font-weight:600;line-height:1.4;">
          ${escapeHtml((c.objeto || 'Sin título').slice(0, 120))}${String(c.objeto || '').length > 120 ? '…' : ''}
        </a>
      </td>
      <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:13px;color:#6b7280;max-width:180px;">
        ${escapeHtml((c.organismo || '—').slice(0, 80))}
      </td>
      <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:13px;color:#111827;font-family:monospace;white-space:nowrap;">
        ${formatImporte(c.importe_licitacion || c.importe_adjudicacion)}
      </td>
      <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:13px;color:#6b7280;font-family:monospace;white-space:nowrap;">
        ${formatDate(c.fecha_publicacion)}
      </td>
      <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:12px;color:#9ca3af;font-family:monospace;white-space:nowrap;">
        ${escapeHtml((c.cpv || '—').slice(0, 20))}
      </td>
    </tr>`
    )
    .join('');

  const frecuenciaLabel = frecuencia === 'diario' ? 'diaria' : 'cada 4 horas';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nuevas licitaciones en Elicita</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="padding:28px 24px 20px;border-bottom:1px solid #e5e7eb;">
              <div style="font-family:monospace;font-size:18px;color:#059669;margin-bottom:6px;font-weight:600;">
                elicita_
              </div>
              <h1 style="margin:0;font-size:20px;font-weight:600;color:#111827;">
                ${nombre ? `Hola, ${escapeHtml(nombre)}` : 'Hola'}
              </h1>
              <p style="margin:8px 0 0;font-size:14px;color:#6b7280;line-height:1.5;">
                ${contratos.length} licitación${contratos.length === 1 ? '' : 'es'} nueva${contratos.length === 1 ? '' : 's'} coinciden con ${alertCount > 1 ? 'tus alertas' : 'tu alerta'} (${frecuenciaLabel}).
              </p>
            </td>
          </tr>

          <!-- Table -->
          <tr>
            <td style="padding:16px 12px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
                <thead>
                  <tr>
                    <th align="left" style="padding:10px 10px 8px;font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #d1d5db;">Objeto</th>
                    <th align="left" style="padding:10px 10px 8px;font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #d1d5db;">Organismo</th>
                    <th align="left" style="padding:10px 10px 8px;font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #d1d5db;">Importe</th>
                    <th align="left" style="padding:10px 10px 8px;font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #d1d5db;">Fecha</th>
                    <th align="left" style="padding:10px 10px 8px;font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid #d1d5db;">CPV</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows}
                </tbody>
              </table>
              ${contratos.length >= MAX_RESULTS ? `
              <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;font-family:monospace;">
                Mostrando las ${MAX_RESULTS} más recientes. Hay más resultados en Elicita.
              </p>` : ''}
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:0 24px 24px;text-align:center;">
              <a href="${ELICITA_URL}/cuenta/alertas" style="display:inline-block;background:#059669;color:#ffffff;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">
                Gestionar alertas →
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:18px 24px;border-top:1px solid #e5e7eb;text-align:center;font-size:12px;color:#6b7280;line-height:1.5;">
              <p style="margin:0 0 8px;">
                <a href="${ELICITA_URL}/cuenta/alertas" style="color:#374151;text-decoration:underline;">Configurar alertas</a> ·
                <a href="mailto:contacto@elicita.es?subject=Unsubscribe%20alertas" style="color:#374151;text-decoration:underline;">Darse de baja</a>
              </p>
              <p style="margin:0;font-family:monospace;font-size:11px;color:#9ca3af;">
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

// ── Resend via fetch ──────────────────────────────────────────────────────
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

// ── Actualizar metadata ─────────────────────────────────────────────────────
async function updateUltimaRevision(user, dateStr) {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) return;

  const current = user.public_metadata || {};
  const alertas = { ...(current.alertas || {}), ultima_revision: dateStr };

  const res = await fetch(`https://api.clerk.com/v1/users/${user.id}/metadata`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ public_metadata: { ...current, alertas } }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Clerk metadata ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function runAlertas(options = {}) {
  loadEnv();
  // Reintentar DuckDB local en cada ciclo; el fallback REST es puntual, no permanente.
  useRestFallback = false;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const startTime = Date.now();

  log('Iniciando revisión de alertas');

  if (!process.env.CLERK_SECRET_KEY) {
    log('ERROR: CLERK_SECRET_KEY no configurada');
    return { ok: false, sent: 0, skipped: 0, errors: 0, error: 'CLERK_SECRET_KEY no configurada' };
  }
  if (!process.env.RESEND_API_KEY) {
    log('ERROR: RESEND_API_KEY no configurada');
    return { ok: false, sent: 0, skipped: 0, errors: 0, error: 'RESEND_API_KEY no configurada' };
  }

  // Inyección de query function para evitar abrir otra conexión DuckDB
  // (por ejemplo cuando se ejecuta dentro del proceso del servidor web).
  const externalQuery = options.queryFn || null;
  if (!externalQuery) {
    await initDb();
    log('DuckDB conectado');
  } else {
    log('Usando conexión DuckDB inyectada');
  }

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  let totalContratos = 0;

  try {
    for await (const user of listUsersWithAlertas()) {
      const alertas = user.public_metadata?.alertas || {};
      const email = getPrimaryVerifiedEmail(user);

      if (!email) {
        log(`[SKIP] ${user.id}: email no verificado`);
        skipped++;
        continue;
      }

      const plan = isAdmin(user) ? 'empresa' : resolvePlan(user.public_metadata);
      const maxAlerts = getMaxAlerts(plan);
      const activeFields = countAlertFields(alertas);

      if (maxAlerts === 0 && !isAdmin(user)) {
        log(`[SKIP] ${email}: plan sin alertas`);
        skipped++;
        continue;
      }

      if (activeFields === 0) {
        log(`[SKIP] ${email}: sin criterios activos`);
        skipped++;
        continue;
      }

      if (Number.isFinite(maxAlerts) && activeFields > maxAlerts) {
        log(`[SKIP] ${email}: excede límite de alertas (${activeFields}/${maxAlerts})`);
        skipped++;
        continue;
      }

      // Frecuencia diaria: saltar si ya se revisó hoy
      if (alertas.frecuencia === 'diario' && alertas.ultima_revision === today) {
        log(`[SKIP] ${email}: frecuencia diaria ya revisada hoy`);
        skipped++;
        continue;
      }

      try {
        const contratos = await findContratos(alertas, alertas.ultima_revision, externalQuery);
        totalContratos += contratos.length;

        if (contratos.length === 0) {
          log(`[OK] ${email}: 0 coincidencias`);
          // Actualizar marca de revisión para no mirar atrás innecesariamente
          await updateUltimaRevision(user, today);
          continue;
        }

        const html = buildEmailHTML({
          nombre: user.first_name || '',
          contratos,
          alertCount: activeFields,
          frecuencia: alertas.frecuencia || '4h',
        });

        const subject = `${contratos.length} ${contratos.length === 1 ? 'nueva licitación' : 'nuevas licitaciones'} coinciden con tus alertas — Elicita`;
        const id = await sendEmail({ to: email, subject, html });

        log(`[SENT] ${email}: ${contratos.length} contratos (Resend id ${id})`);
        sent++;

        await updateUltimaRevision(user, today);

        // Rate limit: esperar entre emails
        await new Promise((r) => setTimeout(r, RESEND_RATE_LIMIT_MS));
      } catch (err) {
        log(`[ERROR] ${email}: ${err.message}`);
        errors++;
      }
    }
  } catch (err) {
    log(`[FATAL] ${err.message}`);
    errors++;
  } finally {
    closeDb();
  }

  const durationMs = Date.now() - startTime;
  log(`Resumen: ${sent} enviados, ${skipped} saltados, ${errors} errores, ${totalContratos} contratos en ${durationMs}ms`);

  return { ok: errors === 0, sent, skipped, errors, totalContratos, durationMs };
}

// CLI / standalone
if (require.main === module) {
  runAlertas()
    .then((res) => {
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      log(`Excepción no controlada: ${err.message}`);
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runAlertas };
