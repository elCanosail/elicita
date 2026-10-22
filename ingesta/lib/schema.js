/**
 * schema.js — Validación de contratos para Elicita
 * ═══════════════════════════════════════════════════════════════════
 *
 * Lección ea-cpp: Zero UB → corrección verificable sobre corrección asumida.
 *
 * Cada contrato que entra al merge debe cumplir un contrato mínimo.
 * Si no cumple, se rechaza (no se mergea silenciosamente).
 *
 * CONTRATO MÍNIMO DE CONTRATO:
 *   - id: string no vacío
 *   - fuente: string no vacío
 *   - fecha_publicacion: string ISO-like (al menos YYYY-MM-DD)
 *   - objeto o titulo: string no vacío (al menos uno)
 *
 * CONTRATO EXTENDIDO (recomendado):
 *   - expediente: string
 *   - estado: string conocido o 'desconocido'
 *   - importe_licitacion: number >= 0 o null
 *   - cpvs: array de strings
 *   - url_fuente: string URL válida
 *
 * SANITY CHECK DE IMPORTES:
 *   - importe_licitacion > MAX_IMPORTE_LICITACION → rechazado (error de fuente)
 *   - importe_adjudicacion > MAX_IMPORTE_ADJUDICACION → rechazado (error de fuente)
 *   - Umbral: €5B (5.000.000.000) — el mayor contrato real español no supera €2-3B
 *   - Casos detectados: taller Oviedo €251B, SAS €560B, UTE GOMSL €90B
 *
 * VALIDACIÓN DE COHERENCIA:
 *   - importe_adjudicacion > importe_licitacion * 10 → flag (probable error)
 *   - importe = 0 con estado adjudicada → flag (importe perdido)
 */

'use strict';

// ── Umbrales de sanity check ──────────────────────────────────────────
// El mayor contrato real español: €2-3B (armamento, infraestructura).
// Umbral generoso a €5B. Cualquier importe above esto es error de fuente.
const MAX_IMPORTE_LICITACION = 5_000_000_000;     // €5B
const MAX_IMPORTE_ADJUDICACION = 5_000_000_000;  // €5B
// Flag de incoherencia: adjudicación 10x mayor que licitación
const ADJUD_OVER_LICIT_FACTOR = 10;

// ── Estados conocidos ──────────────────────────────────────────────────
const KNOWN_ESTADOS = new Set([
  // Activos
  'abierta', 'publicado', 'publicada',
  'anuncio_previo', 'previa',
  'evaluacion', 'evaluación',
  'en curso', 'en curso ',
  'pendiente', 'pendiente de adjudicación',
  'en plazo', 'en_plazo',
  // Terminales
  'adjudicada', 'adjudicado',
  'resuelta', 'resuelto',
  'formalizada', 'formalizado',
  'anulada', 'anulado',
  'desierta', 'desierto',
  'retirada', 'retirado',
  // Otros
  'desconocido',
]);

// ── Validación de resultado de conector ────────────────────────────────
// Devuelve { valid: Contract[], rejected: { contrato, reason }[] }

function validateContratos(contratos, { fuente = 'unknown', strict = false } = {}) {
  const valid = [];
  const rejected = [];

  for (const c of contratos) {
    const errors = [];

    // ID obligatorio
    if (!c.id || typeof c.id !== 'string' || c.id.trim() === '') {
      errors.push('missing or empty id');
    }

    // Fuente obligatoria (puede venir del conector o del propio contrato)
    const fuenteContrato = c.fuente || fuente;
    if (!fuenteContrato || fuenteContrato === 'unknown') {
      errors.push('missing fuente');
    }

    // Fecha de publicación obligatoria (mínimo YYYY-MM-DD)
    if (!c.fecha_publicacion || typeof c.fecha_publicacion !== 'string') {
      errors.push('missing fecha_publicacion');
    } else if (!/^\d{4}-\d{2}-\d{2}/.test(c.fecha_publicacion)) {
      errors.push(`invalid fecha_publicacion format: ${c.fecha_publicacion.slice(0, 20)}`);
    } else {
      // Validar que la fecha está en un rango razonable
      const year = parseInt(c.fecha_publicacion.slice(0, 4), 10);
      if (isNaN(year) || year < 2000 || year > 2100) {
        errors.push(`absurd fecha_publicacion year: ${year} (must be 2000-2100)`);
      }
    }

    // Validar fecha_fin si viene
    if (c.fecha_fin_presentacion && typeof c.fecha_fin_presentacion === 'string') {
      const yearFin = parseInt(c.fecha_fin_presentacion.slice(0, 4), 10);
      if (!isNaN(yearFin) && (yearFin < 2000 || yearFin > 2100)) {
        errors.push(`absurd fecha_fin year: ${yearFin} (must be 2000-2100)`);
      }
    }

    // Objeto o título obligatorio (al menos uno)
    const titulo = extractText(c.titulo) || extractText(c.objeto);
    if (!titulo || titulo.trim() === '') {
      errors.push('missing titulo/objeto');
    }

    // Estado: si viene, debe ser conocido
    if (c.estado && !KNOWN_ESTADOS.has(c.estado.toLowerCase().trim())) {
      if (strict) {
        errors.push(`unknown estado: ${c.estado}`);
      }
      // En modo no-strict, aceptamos estados desconocidos pero los normalizamos
    }

    // Importe licitación: si viene, debe ser number >= 0 o null
    if (c.importe_licitacion !== undefined && c.importe_licitacion !== null) {
      if (typeof c.importe_licitacion !== 'number' || c.importe_licitacion < 0) {
        errors.push(`invalid importe_licitacion: ${c.importe_licitacion}`);
      } else if (c.importe_licitacion > MAX_IMPORTE_LICITACION) {
        errors.push(`absurd importe_licitacion: €${c.importe_licitacion.toLocaleString('es-ES')} (max €${MAX_IMPORTE_LICITACION.toLocaleString('es-ES')})`);
      }
    }

    // Importe adjudicación: si viene, debe ser number >= 0 o null
    if (c.importe_adjudicacion !== undefined && c.importe_adjudicacion !== null) {
      if (typeof c.importe_adjudicacion !== 'number' || c.importe_adjudicacion < 0) {
        errors.push(`invalid importe_adjudicacion: ${c.importe_adjudicacion}`);
      } else if (c.importe_adjudicacion > MAX_IMPORTE_ADJUDICACION) {
        errors.push(`absurd importe_adjudicacion: €${c.importe_adjudicacion.toLocaleString('es-ES')} (max €${MAX_IMPORTE_ADJUDICACION.toLocaleString('es-ES')})`);
      }
    }

    // Coherencia: adjudicación desproporcionadamente mayor que licitación
    if (c.importe_licitacion && c.importe_adjudicacion &&
        c.importe_licitacion > 0 && c.importe_adjudicacion > 0 &&
        c.importe_adjudicacion > c.importe_licitacion * ADJUD_OVER_LICIT_FACTOR) {
      // No rechazamos — puede ser un presupuesto modificado (ampliaciones,
      // modificaciones contractuales legítimas). Solo conviene revisarlo.
      // FIX (tarea B 12-10): este bloque referenciaba `opts.logSuspicious`,
      // variable inexistente (la función destructura sus args) → ReferenceError
      // que CRASHEABA validateContratos — y con él el merge del conector entero —
      // en cuanto un contrato traía adjudicación >10× licitación. El bloque era
      // vacío (log no implementado): se elimina el wrapper muerto.
    }

    // CPVs: si viene, debe ser array de strings
    if (c.cpvs !== undefined && c.cpvs !== null) {
      if (!Array.isArray(c.cpvs)) {
        errors.push(`cpvs is not array: ${typeof c.cpvs}`);
      }
    }

    if (errors.length > 0) {
      rejected.push({
        contrato: c.id || '(no id)',
        fuente: fuenteContrato,
        errors,
      });
    } else {
      // Normalizar campos mínimos
      valid.push({
        ...c,
        fuente: fuenteContrato,
        estado: normalizeEstado(c.estado),
      });
    }
  }

  return { valid, rejected };
}

// ── Normalizar estado ──────────────────────────────────────────────────
function normalizeEstado(estado) {
  if (!estado) return 'desconocido';
  const e = estado.toLowerCase().trim();
  if (KNOWN_ESTADOS.has(e)) return e;
  // Mapeos comunes
  if (e.includes('adjudicad')) return 'adjudicada';
  if (e.includes('formalizad')) return 'formalizada';
  if (e.includes('resuel')) return 'resuelta';
  if (e.includes('anulad')) return 'anulada';
  if (e.includes('desiert')) return 'desierta';
  if (e.includes('retirad')) return 'retirada';
  if (e.includes('abiert') || e.includes('en plazo') || e.includes('publicad')) return 'abierta';
  if (e.includes('pendient') || e.includes('evaluaci')) return 'pendiente';
  return 'desconocido';
}

// ── Extraer texto multilingüe ──────────────────────────────────────────
function extractText(val, langPriority = ['spa', 'eng']) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    for (const lang of langPriority) {
      const found = val.find(item => {
        const itemLang = item?.['@language']?.toLowerCase() || item?.['@xml:lang']?.toLowerCase();
        return itemLang === lang || itemLang?.startsWith(lang);
      });
      if (found) return extractText(found);
    }
    return extractText(val[0]);
  }
  if (typeof val === 'object') {
    if (val['#text']) return val['#text'];
    for (const lang of langPriority) {
      if (val[lang]) {
        const langVal = val[lang];
        if (Array.isArray(langVal)) return extractText(langVal[0]);
        return String(langVal);
      }
    }
    return JSON.stringify(val);
  }
  return String(val);
}

module.exports = {
  validateContratos,
  normalizeEstado,
  KNOWN_ESTADOS,
  extractText,
  MAX_IMPORTE_LICITACION,
  MAX_IMPORTE_ADJUDICACION,
  ADJUD_OVER_LICIT_FACTOR,
};