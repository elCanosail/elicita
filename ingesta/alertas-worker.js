/**
 * Alertas Worker — Elicita
 * ═══════════════════════════════════════════════════════════════════
 *
 * Cada ejecución:
 * 1. Lee usuarios con alertas activas desde Clerk
 * 2. Para cada usuario, busca licitaciones nuevas que coincidan
 * 3. Envía email con resumen via Resend
 *
 * Ejecución: cron diario 07:00 CET (05:00 UTC)
 * También puede ejecutarse manualmente: node alertas-worker.js
 */

const { Resend } = require('resend');
const duckdb = require('duckdb');

// ── Config ────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
const RESEND_KEY = process.env.RESEND_API_KEY;
const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
const ELICITA_URL = process.env.ELICITA_URL || 'https://elicita.es';
const FROM_EMAIL = 'noreply@elicita.es';
const MAX_RESULTS_PER_ALERT = 10;
const COMPETITOR_EMAIL_BATCH_LIMIT = 50;

// ── Logging ───────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] [alertas] ${msg}`);
}

// ── DuckDB ─────────────────────────────────────────────────────────────────
let db, conn;

function initDb() {
  return new Promise((resolve, reject) => {
    db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
    conn = db.connect();
    conn.all('SELECT 1', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.all(sql, ...params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function closeDb() {
  if (conn) conn.close();
  if (db) db.close();
}

// ── Clerk ──────────────────────────────────────────────────────────────────
async function getUsersWithAlertas() {
  if (!CLERK_SECRET) {
    log('No CLERK_SECRET_KEY — skipping user lookup');
    return [];
  }

  const res = await fetch('https://api.clerk.com/v1/users?limit=100', {
    headers: {
      'Authorization': `Bearer ${CLERK_SECRET}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    log(`Clerk API error: ${res.status}`);
    return [];
  }

  const data = await res.json();
  const users = (data.data || data || []).filter(u => {
    const alertas = u.public_metadata?.alertas;
    return alertas && alertas.activo !== false;
  });

  return users.map(u => ({
    id: u.id,
    email: u.email_addresses?.[0]?.email_address || '',
    nombre: u.first_name || '',
    alertas: u.public_metadata.alertas,
  }));
}

// ── Helpers de CPV y organismo ───────────────────────────────────────────
function getCpvPrefixes(alerta) {
  if (!alerta.cpvs || alerta.cpvs.length === 0) return [];
  return alerta.cpvs
    .map(c => String(c).replace('.0', '').trim().slice(0, 5))
    .filter(c => c.length === 5);
}

/**
 * Genera cláusula SQL para filtrar por prefijos CPV.
 * - Para columnas VARCHAR (contratos_vivos.cpv): usa SUBSTRING + IN
 * - Para columnas VARCHAR[] (boe.cpvs): usa array_to_string + LIKE
 */
function getCpvSqlForVarchar(field, prefixes) {
  if (prefixes.length === 0) return null;
  const placeholders = prefixes.map(() => '?').join(',');
  return `SUBSTRING(REPLACE(REPLACE(${field}, '.0', ''), ' ', ''), 1, 5) IN (${placeholders})`;
}

function getCpvSqlForArray(field, prefixes) {
  if (prefixes.length === 0) return null;
  // Convertir array a string y buscar prefijos con LIKE
  const likes = prefixes.map(() => `array_to_string(${field}, ',') LIKE ?`).join(' OR ');
  return `(${likes})`;
}

function getOrganismoSqlWhere(alerta) {
  if (!alerta.organismos || alerta.organismos.length === 0) return null;
  const orgConditions = alerta.organismos.map(() => 'LOWER(organismo) LIKE ?');
  return `(${orgConditions.join(' OR ')})`;
}

function formatImporte(importe) {
  if (importe == null || importe === '') return '—';
  if (importe >= 1000000) return `€${(importe / 1000000).toFixed(2)}M`;
  if (importe >= 1000) return `€${(importe / 1000).toFixed(0)}K`;
  return `€${importe.toFixed(2)}`;
}

// ── Buscar licitaciones para una alerta ────────────────────────────────────
async function findContratosForAlerta(alerta) {
  const conditions = [];
  const params = [];

  // Solo licitaciones abiertas/publicadas
  conditions.push("LOWER(estado) IN ('abierta', 'publicada', 'anuncio_previo', 'en evaluacion')");

  // Solo licitaciones publicadas en las últimas 24h (o desde la última ejecución si existe)
  // Si no hay last_run, usar 24h atrás como fallback (no 30 días)
  const lastRun = alerta.last_run || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  conditions.push(`fecha_publicacion >= '${lastRun}'`);

  // CPV filter
  const prefixes = getCpvPrefixes(alerta);
  if (prefixes.length > 0) {
    const placeholders = prefixes.map(() => '?').join(',');
    conditions.push(`SUBSTRING(REPLACE(REPLACE(cpv, '.0', ''), ' ', ''), 1, 5) IN (${placeholders})`);
    params.push(...prefixes);
  }

  // Keywords filter (text search)
  if (alerta.keywords && alerta.keywords.length > 0) {
    const keywordConditions = alerta.keywords.map(kw => {
      const terms = kw.toLowerCase().split(/\s+/).filter(t => t.length > 1);
      return terms.map(term => {
        params.push(`%${term}%`, `%${term}%`);
        return '(LOWER(objeto) LIKE ? OR LOWER(organismo) LIKE ?)';
      }).join(' AND ');
    });
    if (keywordConditions.length > 0) {
      conditions.push(`(${keywordConditions.join(' OR ')})`);
    }
  }

  // Organismo filter
  const orgWhere = getOrganismoSqlWhere(alerta);
  if (orgWhere) {
    conditions.push(orgWhere);
    params.push(...alerta.organismos.map(o => `%${o.toLowerCase()}%`));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      id, fuente, organismo, objeto, cpv,
      importe_licitacion, fecha_publicacion, fecha_fin, estado
    FROM contratos_vivos
    ${where}
    ORDER BY fecha_publicacion DESC
    LIMIT ${MAX_RESULTS_PER_ALERT}
  `;

  try {
    const rows = await query(sql, params);
    return rows.map(r => ({
      id: r.id || '',
      organismo: r.organismo || '',
      objeto: r.objeto || 'Sin título',
      cpv: r.cpv || '',
      importe: formatImporte(r.importe_licitacion),
      fecha: r.fecha_publicacion ? String(r.fecha_publicacion).slice(0, 10) : '',
      deadline: r.fecha_fin ? String(r.fecha_fin).slice(0, 10) : '',
      estado: r.estado || '',
    }));
  } catch (err) {
    log(`Query error: ${err.message}`);
    return [];
  }
}

// ── Buscar formalizaciones/adjudicaciones en sector ────────────────────────
async function findFormalizacionesForSector(alerta) {
  const prefixes = getCpvPrefixes(alerta);
  if (prefixes.length === 0) return [];

  const conditions = [];
  const params = [];

  conditions.push("estado = 'formalizada'");

  const periodoInicio = alerta.last_run || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  conditions.push('fecha_publicacion >= ?');
  params.push(periodoInicio);

  // CPV filter — boe.cpvs es VARCHAR[], usar array_to_string + LIKE
  const cpvWhere = getCpvSqlForArray('cpvs', prefixes);
  if (cpvWhere) {
    conditions.push(cpvWhere);
    params.push(...prefixes.map(p => `${p}%`));
  }

  const orgWhere = getOrganismoSqlWhere(alerta);
  if (orgWhere) {
    conditions.push(orgWhere);
    params.push(...alerta.organismos.map(o => `%${o.toLowerCase()}%`));
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const sql = `
    SELECT
      id, organismo, objeto, cpvs,
      importe_licitacion, importe_adjudicacion,
      fecha_publicacion, estado,
      url AS url_fuente, adjudicatario, nif_adjudicatario
    FROM boe
    ${where}
    ORDER BY fecha_publicacion DESC
    LIMIT ${MAX_RESULTS_PER_ALERT}
  `;

  try {
    const rows = await query(sql, params);
    return rows.map(r => ({
      id: r.id || '',
      titulo: r.objeto || 'Sin título',
      organismo: r.organismo || '',
      objeto: r.objeto || 'Sin objeto',
      cpvs: r.cpvs || '',
      importeLicitacion: formatImporte(r.importe_licitacion),
      importeAdjudicacion: formatImporte(r.importe_adjudicacion),
      importeAdjudicacionRaw: r.importe_adjudicacion || 0,
      fechaPublicacion: r.fecha_publicacion ? String(r.fecha_publicacion).slice(0, 10) : '',
      fechaAdjudicacion: '',
      estado: r.estado || '',
      urlFuente: r.url_fuente || '',
      adjudicatario: r.adjudicatario || 'Sin identificar',
      nifAdjudicatario: r.nif_adjudicatario || '',
      nifResolved: false,
      numOfertas: null,
    }));
  } catch (err) {
    log(`Query error findFormalizacionesForSector: ${err.message}`);
    return [];
  }
}

// ── Buscar formalizaciones de competidores ───────────────────────────────
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

  if (compNif && rowNif === compNif) {
    return true;
  }

  const compName = canonName(competidor.nombre);
  const rowName = canonName(row.adjudicatario);
  if (compName && rowName) {
    if (rowName === compName || rowName.includes(compName) || compName.includes(rowName)) {
      return true;
    }
  }

  return false;
}

async function findFormalizacionesForCompetitors(user) {
  const competidores = user.alertas?.competidores;
  if (!Array.isArray(competidores) || competidores.length === 0) {
    return [];
  }

  const lastRun = user.alertas.last_run || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const sql = `
    SELECT
      id, fuente, organismo, objeto, adjudicatario, nif_adjudicatario,
      importe_adjudicacion, fecha_publicacion,
      url AS url_fuente
    FROM boe
    WHERE LOWER(estado) = 'formalizada'
      AND fecha_publicacion >= ?
      AND (nif_adjudicatario IS NOT NULL OR adjudicatario IS NOT NULL)
    ORDER BY fecha_publicacion DESC
    LIMIT ${COMPETITOR_EMAIL_BATCH_LIMIT}
  `;

  try {
    const rows = await query(sql, [lastRun]);
    const matches = [];

    for (const r of rows) {
      for (const c of competidores) {
        if (matchCompetidor(r, c)) {
          matches.push({
            id: r.id || '',
            organismo: r.organismo || '',
            objeto: r.objeto || 'Sin título',
            adjudicatario: r.adjudicatario || '',
            nif_adjudicatario: r.nif_adjudicatario || '',
            nif_verificado: false,
            importe_adjudicacion: formatImporte(r.importe_adjudicacion),
            importe_raw: r.importe_adjudicacion ? Number(r.importe_adjudicacion) : null,
            fecha_publicacion: r.fecha_publicacion ? String(r.fecha_publicacion).slice(0, 10) : '',
            fecha_adjudicacion: '',
            num_ofertas: null,
            modalidad: '',
            url_fuente: r.url_fuente || '',
            competidor: c,
          });
          break;
        }
      }
    }

    return matches;
  } catch (err) {
    log(`Competitor query error for ${user.email}: ${err.message}`);
    return [];
  }
}

function formatCompetitorEmailHTML(nombre, formalizaciones, competidor) {
  const rows = formalizaciones.map(f => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #e5e7eb">
        <div style="font-size:12px;font-weight:600;color:#059669;margin-bottom:4px;font-family:monospace">
          ${escapeHtml(f.competidor.nombre)} ${f.nif_verificado ? '<span style="display:inline-block;margin-left:6px;padding:2px 6px;border-radius:4px;background:#d1fae5;color:#059669;font-size:10px;font-weight:600">NIF verificado</span>' : ''}
        </div>
        <a href="${f.url_fuente || `${ELICITA_URL}/monitor/licitacion/${encodeURIComponent(f.id)}`}"
           style="color:#111827;text-decoration:none;font-size:14px;font-weight:500;line-height:1.4">
          ${escapeHtml(f.objeto.slice(0, 110))}
        </a>
        <div style="margin-top:6px;font-family:monospace;font-size:11px;color:#6b7280;line-height:1.5">
          ${escapeHtml(f.organismo.slice(0, 70))}<br>
          Importe adjudicado: ${f.importe_adjudicacion}
          ${f.fecha_adjudicacion ? ` · Fecha: ${f.fecha_adjudicacion}` : ''}
          ${f.num_ofertas != null ? ` · Ofertas: ${f.num_ofertas}` : ''}
        </div>
      </td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#ffffff;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px">

    <div style="margin-bottom:32px">
      <div style="font-family:monospace;font-size:15px;color:#059669;margin-bottom:8px;font-weight:600">
        elicita_
      </div>
      <h1 style="margin:0;font-size:20px;font-weight:600;color:#111827">
        ${nombre ? `Hola, ${escapeHtml(nombre)}` : 'Tu competidor ganó un contrato'}
      </h1>
      <p style="margin:8px 0 0;font-size:13px;color:#6b7280">
        ${formalizaciones.length} formalización${formalizaciones.length !== 1 ? 'es' : ''} de BOE detectada${formalizaciones.length !== 1 ? 's' : ''} para ${escapeHtml(competidor.nombre)}
      </p>
    </div>

    <table style="width:100%;border-collapse:collapse">
      ${rows}
    </table>

    ${formalizaciones.length >= COMPETITOR_EMAIL_BATCH_LIMIT ? `
    <p style="font-family:monospace;font-size:11px;color:#9ca3af;margin-top:16px">
      Mostrando las ${COMPETITOR_EMAIL_BATCH_LIMIT} formalizaciones más recientes. Puede haber más.
    </p>` : ''}

    <div style="margin-top:32px;text-align:center">
      <a href="${ELICITA_URL}/cuenta/alertas"
         style="display:inline-block;background:#059669;color:#ffffff;padding:12px 28px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none">
        Gestionar alertas →
      </a>
    </div>

    <div style="margin-top:40px;padding-top:16px;border-top:1px solid #e5e7eb;font-family:monospace;font-size:10px;color:#9ca3af;text-align:center">
      elicita_ · Inteligencia sobre contratación pública<br>
      <a href="${ELICITA_URL}/cuenta" style="color:#6b7280;text-decoration:none">Gestionar alertas</a>
    </div>
  </div>
</body>
</html>`;
}

async function updateLastRun(user) {
  try {
    const updatedAlertas = { ...user.alertas, last_run: new Date().toISOString().slice(0, 10) };
    await fetch(`https://api.clerk.com/v1/users/${user.id}/metadata`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${CLERK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        public_metadata: { alertas: updatedAlertas },
      }),
    });
  } catch (e) {
    log(`Failed to update last_run for ${user.id}: ${e.message}`);
  }
}

// ── Formatear email ───────────────────────────────────────────────────────
function formatEmailHTML(nombre, contratos, alerta, formalizaciones = []) {
  const keywords = (alerta.keywords || []).join(', ');
  const cpvs = (alerta.cpvs || []).join(', ');

  const contratoRows = contratos.map(c => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e5e7eb">
        <a href="${ELICITA_URL}/monitor/licitacion/${encodeURIComponent(c.id)}"
           style="color:#059669;text-decoration:none;font-size:14px;font-weight:600">
          ${escapeHtml(c.objeto.slice(0, 100))}
        </a>
        <div style="margin-top:4px;font-family:monospace;font-size:11px;color:#6b7280">
          ${escapeHtml(c.organismo.slice(0, 60))}
          ${c.importe !== '—' ? ` · ${c.importe}` : ''}
          ${c.deadline ? ` · Plazo: ${c.deadline}` : ''}
        </div>
      </td>
    </tr>
  `).join('');

  const hasFormalizaciones = formalizaciones && formalizaciones.length > 0;
  const totalImporte = hasFormalizaciones
    ? formalizaciones.reduce((sum, f) => sum + (Number(f.importeAdjudicacionRaw) || 0), 0)
    : 0;
  const avgImporte = hasFormalizaciones && formalizaciones.length > 0
    ? totalImporte / formalizaciones.length
    : 0;
  const avgOfertas = hasFormalizaciones
    ? formalizaciones.filter(f => f.numOfertas != null).reduce((sum, f) => sum + f.numOfertas, 0)
      / Math.max(1, formalizaciones.filter(f => f.numOfertas != null).length)
    : 0;
  const ofertasText = formalizaciones.some(f => f.numOfertas != null)
    ? ` · Media de ofertas: ${avgOfertas.toFixed(1)}`
    : '';

  const formalizacionRows = hasFormalizaciones
    ? formalizaciones.map(f => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #e5e7eb">
          <div style="font-size:14px;font-weight:600;color:#111827">
            ${escapeHtml(f.objeto.slice(0, 100))}
          </div>
          <div style="margin-top:4px;font-family:monospace;font-size:11px;color:#6b7280">
            ${escapeHtml(f.organismo.slice(0, 60))}
            ${f.importeAdjudicacion !== '—' ? ` · ${f.importeAdjudicacion}` : ''}
            ${f.fechaAdjudicacion ? ` · Adjudicado: ${f.fechaAdjudicacion}` : ''}
          </div>
          <div style="margin-top:6px;font-size:13px;color:#374151">
            Adjudicatario: <strong>${escapeHtml(f.adjudicatario.slice(0, 60))}</strong>
            ${f.nifResolved ? '<span style="display:inline-block;background:#d1fae5;color:#059669;border-radius:4px;padding:2px 6px;margin-left:6px;font-size:10px;font-weight:600">NIF verificado</span>' : ''}
            ${f.numOfertas != null ? ` · ${f.numOfertas} oferta${f.numOfertas !== 1 ? 's' : ''}` : ''}
          </div>
          ${f.urlFuente ? `
          <div style="margin-top:6px;font-size:12px;">
            <a href="${escapeHtml(f.urlFuente)}" style="color:#059669;text-decoration:none;font-weight:500">Ver en el BOE →</a>
          </div>` : ''}
        </td>
      </tr>
    `).join('')
    : '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#ffffff;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px">

    <!-- Header -->
    <div style="margin-bottom:32px">
      <div style="font-family:monospace;font-size:15px;color:#059669;margin-bottom:8px;font-weight:600">
        elicita_
      </div>
      <h1 style="margin:0;font-size:20px;font-weight:600;color:#111827">
        ${nombre ? `Hola, ${escapeHtml(nombre)}` : 'Nuevas oportunidades'}
      </h1>
      <p style="margin:8px 0 0;font-size:13px;color:#6b7280">
        ${contratos.length} licitación${contratos.length !== 1 ? 'es' : ''} nueva${contratos.length !== 1 ? 's' : ''}${hasFormalizaciones ? ` y ${formalizaciones.length} adjudicación${formalizaciones.length !== 1 ? 'es' : ''}` : ''} que coinciden con tu perfil
      </p>
    </div>

    <!-- Alert info -->
    ${keywords ? `
    <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;padding:12px 16px;margin-bottom:24px;font-family:monospace;font-size:11px;color:#047857">
      🔍 Búsqueda: ${escapeHtml(keywords)}
      ${cpvs ? `<br>🏷️ CPVs: ${escapeHtml(cpvs)}` : ''}
    </div>` : ''}

    ${contratoRows ? `
    <!-- Results -->
    <div style="margin-bottom:8px;font-size:16px;font-weight:600;color:#111827">Licitaciones nuevas en tu sector</div>
    <table style="width:100%;border-collapse:collapse">
      ${contratoRows}
    </table>

    ${contratos.length >= MAX_RESULTS_PER_ALERT ? `
    <p style="font-family:monospace;font-size:11px;color:#9ca3af;margin-top:16px">
      Mostrando las ${MAX_RESULTS_PER_ALERT} más recientes. Puede haber más.
    </p>` : ''}
    ` : ''}

    ${hasFormalizaciones ? `
    <!-- Adjudicaciones -->
    <div style="margin-top:40px;margin-bottom:8px;font-size:16px;font-weight:600;color:#111827">📊 Adjudicaciones en tu sector</div>
    <table style="width:100%;border-collapse:collapse">
      ${formalizacionRows}
    </table>

    ${formalizaciones.length >= MAX_RESULTS_PER_ALERT ? `
    <p style="font-family:monospace;font-size:11px;color:#9ca3af;margin-top:16px">
      Mostrando las ${MAX_RESULTS_PER_ALERT} más recientes. Puede haber más.
    </p>` : ''}

    <div style="margin-top:16px;padding:12px 16px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;font-family:monospace;font-size:11px;color:#047857">
      Importe medio: ${formatImporte(avgImporte)}${ofertasText}
    </div>
    ` : ''}

    <!-- CTA -->
    <div style="margin-top:32px;text-align:center">
      <a href="${ELICITA_URL}/monitor/activas"
         style="display:inline-block;background:#059669;color:#ffffff;padding:12px 28px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none">
        Ver todas las licitaciones →
      </a>
    </div>

    <!-- Footer -->
    <div style="margin-top:40px;padding-top:16px;border-top:1px solid #e5e7eb;font-family:monospace;font-size:10px;color:#9ca3af;text-align:center">
      elicita_ · Inteligencia sobre contratación pública<br>
      <a href="${ELICITA_URL}/cuenta" style="color:#6b7280;text-decoration:none">Gestionar alertas</a>
    </div>

  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Enviar email ──────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) {
    log(`[DRY RUN] Email to ${to}: ${subject}`);
    return true;
  }

  const resend = new Resend(RESEND_KEY);
  try {
    const result = await resend.emails.send({
      from: `elicita_ <${FROM_EMAIL}>`,
      to,
      subject,
      html,
    });
    log(`Email sent to ${to}: ${result.id || 'ok'}`);
    return true;
  } catch (err) {
    log(`Email error for ${to}: ${err.message}`);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  log('Starting alertas worker...');

  try {
    await initDb();
    log('DuckDB connected');

    const users = await getUsersWithAlertas();
    log(`Found ${users.length} users with active alertas`);

    if (users.length === 0) {
      log('No users to process. Exiting.');
      closeDb();
      return;
    }

    let totalSent = 0;
    let totalContratos = 0;
    let totalFormalizaciones = 0;
    let totalCompetitorEmails = 0;

    for (const user of users) {
      if (!user.email) {
        log(`Skipping user ${user.id}: no email`);
        continue;
      }

      const contratos = await findContratosForAlerta(user.alertas);
      const formalizaciones = await findFormalizacionesForSector(user.alertas);

      totalContratos += contratos.length;
      totalFormalizaciones += formalizaciones.length;

      const hayContratos = contratos.length > 0;
      const hayFormalizaciones = formalizaciones.length > 0;

      if (!hayContratos && !hayFormalizaciones) {
        log(`No news for ${user.email}`);
        continue;
      }

      let subject;
      if (hayContratos && hayFormalizaciones) {
        subject = `${contratos.length} licitación${contratos.length !== 1 ? 'es' : ''} y ${formalizaciones.length} adjudicación${formalizaciones.length !== 1 ? 'es' : ''} en tu sector`;
      } else if (hayFormalizaciones) {
        const hoy = new Date().toISOString().slice(0, 10);
        const inicio = user.alertas.last_run || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const periodo = inicio === hoy ? 'hoy' : `${inicio} → ${hoy}`;
        subject = `📊 ${formalizaciones.length} adjudicación${formalizaciones.length !== 1 ? 'es' : ''} en tu sector ${periodo}`;
      } else {
        subject = `${contratos.length} licitación${contratos.length !== 1 ? 'es' : ''} nueva${contratos.length !== 1 ? 's' : ''} para ti`;
      }

      const html = formatEmailHTML(user.nombre, hayContratos ? contratos : [], user.alertas, formalizaciones);

      const sent = await sendEmail(user.email, subject, html);
      if (sent) {
        totalSent++;
        await updateLastRun(user);
      }

      // 2. Alertas de competidores
      const compMatches = await findFormalizacionesForCompetitors(user);
      if (compMatches.length > 0) {
        const byCompetidor = {};
        for (const m of compMatches) {
          const key = m.competidor.nif || m.competidor.nombre;
          if (!byCompetidor[key]) byCompetidor[key] = { competidor: m.competidor, matches: [] };
          byCompetidor[key].matches.push(m);
        }

        for (const key of Object.keys(byCompetidor)) {
          const { competidor, matches } = byCompetidor[key];
          const compSubject = `🏆 ${competidor.nombre} ganó un contrato`;
          const compHtml = formatCompetitorEmailHTML(user.nombre, matches, competidor);
          const compSent = await sendEmail(user.email, compSubject, compHtml);
          if (compSent) {
            totalCompetitorEmails++;
            await updateLastRun(user);
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // Rate limit: 1s between emails
      await new Promise(r => setTimeout(r, 1000));
    }

    log(`Done. ${totalSent} alert emails sent, ${totalCompetitorEmails} competitor emails sent, ${totalContratos} contratos, ${totalFormalizaciones} formalizaciones total`);

  } catch (err) {
    log(`Fatal error: ${err.message}`);
    console.error(err);
  } finally {
    closeDb();
  }
}

main();