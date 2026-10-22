/**
 * merge.js — Merge-by-ID para contratos de elicita_
 * ═══════════════════════════════════════════════════
 *
 * PROBLEMA:
 *   Cada conector escribe su JSON con writeFileSync sobreescribiendo el anterior.
 *   Una licitación publicada hace 45 días desaparece aunque siga abierta.
 *
 * SOLUCIÓN:
 *   Merge por ID: leer JSON existente, fusionar con nuevos contratos por ID (upsert),
 *   purgar los que ya no están activos ni son recientes, escribir resultado.
 *
 * REGLAS DE RETENCIÓN:
 *   1. Contratos con estado ACTIVO → se mantienen SIEMPRE (hasta que cambien de estado)
 *   2. Contratos con fecha_fin >= hoy → se mantienen (plazo no vencido)
 *   3. Contratos adjudicados/formalizados → se mantienen MAX_AGE_ADJUDICADOS días
 *   4. Contratos sin fecha ni estado reconocido → se mantienen MAX_AGE_DEFAULT días
 *
 * USO:
 *   const { mergeAndWrite } = require('./lib/merge');
 *   mergeAndWrite(DATA_FILE, newContratos, { fuente: 'PLACSP', meta: {...} });
 *
 * DECISIÓN: D013 en DECISIONS.md
 */

const fs   = require('fs');
const path = require('path');

// ── Estados activos (licitación viva) ────────────────────────────────
const ACTIVE_ESTADOS = new Set([
  'abierta', 'publicado', 'publicada',
  'anuncio_previo', 'previa',
  'evaluacion', 'evaluación',
  'en curso', 'en curso ',           // Galicia trailing space
  'pendiente', 'pendiente de adjudicación',
  'en plazo', 'en_plazo',
]);

// ── Estados terminales (adjudicada, resuelta…) ───────────────────────
const TERMINAL_ESTADOS = new Set([
  'adjudicada', 'adjudicado',
  'resuelta', 'resuelto',
  'formalizada', 'formalizado',
  'anulada', 'anulado',
  'desierta', 'desierto',
  'retirada', 'retirado',
]);

// ── Parámetros de retención ──────────────────────────────────────────
const MAX_AGE_ADJUDICADOS_DAYS = 730;  // 24 meses
const MAX_AGE_DEFAULT_DAYS     = 180;  // 6 meses (red de seguridad)

// ── Utilidades ───────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function isActive(contrato) {
  const estado = (contrato.estado || '').toLowerCase().trim();
  if (ACTIVE_ESTADOS.has(estado)) return true;

  // Si tiene fecha_fin futura, está activo aunque el estado no lo diga
  const fin = parseDate(contrato.fecha_fin);
  if (fin && fin >= new Date()) return true;

  return false;
}

function isTerminal(contrato) {
  const estado = (contrato.estado || '').toLowerCase().trim();
  return TERMINAL_ESTADOS.has(estado);
}

function shouldRetain(contrato, now) {
  // 1. Estado activo → siempre
  if (isActive(contrato)) return true;

  // 2. Terminal → mantener MAX_AGE_ADJUDICADOS_DAYS
  if (isTerminal(contrato)) {
    const pub = parseDate(contrato.fecha_publicacion) ||
                parseDate(contrato._merged_at);
    if (!pub) return true; // Sin fecha → conservar por seguridad
    const age = (now - pub) / 86400000;
    return age <= MAX_AGE_ADJUDICADOS_DAYS;
  }

  // 3. Estado desconocido → mantener MAX_AGE_DEFAULT_DAYS
  const pub = parseDate(contrato.fecha_publicacion) ||
              parseDate(contrato._merged_at);
  if (!pub) return true;
  const age = (now - pub) / 86400000;
  return age <= MAX_AGE_DEFAULT_DAYS;
}

// ── Merge principal ──────────────────────────────────────────────────

/**
 * Lee el JSON existente, fusiona por ID, purga expirados, escribe resultado.
 *
 * @param {string}   filePath       - Ruta al JSON de contratos
 * @param {Array}    newContratos   - Contratos nuevos del ciclo actual
 * @param {Object}   opts
 * @param {string}   opts.fuente    - Nombre de la fuente (ej: 'PLACSP')
 * @param {Object}   [opts.meta]    - Campos extra para el JSON raíz
 * @param {Function} [opts.log]     - Logger (default: console.log)
 * @returns {{ total: number, added: number, updated: number, purged: number, retained: number }}
 */
function mergeAndWrite(filePath, newContratos, opts = {}) {
  const { fuente = 'unknown', meta = {}, log = console.log, skipPurge = false } = opts;
  const now = new Date();

  // 1. Leer existentes
  let existing = [];
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      existing = raw.contratos || [];
    }
  } catch (e) {
    log(`[merge] ⚠️ Error leyendo ${filePath}: ${e.message}. Se parte de vacío.`);
    existing = [];
  }

  // 2. Validar contratos nuevos contra schema
  const { validateContratos } = require('./schema');
  const validation = validateContratos(newContratos, { fuente });
  const validContratos = validation.valid;
  if (validation.rejected.length > 0) {
    log(`[merge] ${fuente}: ⚠️ ${validation.rejected.length} contratos rechazados por schema`);
    for (const r of validation.rejected.slice(0, 5)) {
      log(`[merge]   - ${r.contrato}: ${r.errors.join(', ')}`);
    }
    if (validation.rejected.length > 5) {
      log(`[merge]   ... y ${validation.rejected.length - 5} más`);
    }
  }

  // 3. Indexar existentes por ID
  const index = new Map();
  for (const c of existing) {
    if (c.id) index.set(c.id, c);
  }

  // 4. Upsert validados (los nuevos tienen prioridad — datos más frescos)
  let added = 0, updated = 0;
  for (const c of validContratos) {
    if (!c.id) continue;
    c._merged_at = now.toISOString();

    if (index.has(c.id)) {
      // Merge: mantener campos del existente que el nuevo no trae
      const old = index.get(c.id);
      const merged = { ...old, ...c };
      // Preservar _first_seen del original
      if (old._first_seen) merged._first_seen = old._first_seen;
      // PLACSP: fecha_publicacion es realmente fecha_actualizacion (atom:updated).
      // Preservar la fecha_publicacion original del primer ingreso para no perderla.
      if (c.fuente === 'PLACSP' && old._first_seen && old.fecha_publicacion) {
        merged.fecha_publicacion = old.fecha_publicacion;
        // Guardar la fecha de actualización real en campo separado
        merged.fecha_actualizacion = c.fecha_publicacion || null;
      }
      index.set(c.id, merged);
      updated++;
    } else {
      c._first_seen = now.toISOString();
      index.set(c.id, c);
      added++;
    }
  }

  // 5. Purgar expirados (skipPurge=true en backfills históricos)
  let purged = 0;
  if (!skipPurge) {
    for (const [id, c] of index) {
      if (!shouldRetain(c, now)) {
        index.delete(id);
        purged++;
      }
    }
  }

  // 6. Escribir resultado
  const contratos = Array.from(index.values());

  // Ordenar: activos primero, luego por fecha desc
  contratos.sort((a, b) => {
    const aActive = isActive(a) ? 0 : 1;
    const bActive = isActive(b) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    const da = parseDate(a.fecha_publicacion) || new Date(0);
    const db = parseDate(b.fecha_publicacion) || new Date(0);
    return db - da;
  });

  const output = {
    ...meta,
    fuente,
    ultima_actualizacion: now.toISOString(),
    total: contratos.length,
    _merge_stats: {
      ciclo: now.toISOString(),
      existentes_previos: existing.length,
      nuevos_recibidos: newContratos.length,
      validados: validContratos.length,
      rechazados_schema: validation.rejected.length,
      añadidos: added,
      actualizados: updated,
      purgados: purged,
      total_final: contratos.length,
    },
    contratos,
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2), 'utf8');

  const stats = { total: contratos.length, added, updated, purged, retained: contratos.length };
  log(`[merge] ${fuente}: +${added} nuevos, ~${updated} actualizados, -${purged} purgados → ${contratos.length} total`);

  return stats;
}

module.exports = { mergeAndWrite, isActive, isTerminal, shouldRetain, ACTIVE_ESTADOS, TERMINAL_ESTADOS };
