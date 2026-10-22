/**
 * Temporal estimator for the Radar renewal opportunities.
 *
 * Computes estimated_end_date from a RadarRecord that has either:
 * - explicit start + duration  → contractual_scenario
 * - award date/formalization + duration → award_proxy_scenario
 *
 * Does NOT:
 * - Infer start from DT_DISPATCH / fecha_publicacion
 * - Infer end from fecha_fin (deadline) when no duration anchor exists
 * - Use +365 fallback when duration is missing
 * - Aggregate lots or duplicates
 * - Set prórroga (always unknown)
 * - Set confidence (always null)
 */

import type { RadarRecord, EstimationStatus, Basis, DurationUnit } from './inventory';
import {
  addMonths,
  addDays,
  addYears,
  parseDate,
  formatDate,
} from './calendar';
import { isValidISODate, FECHA_FIN_MAPPING } from './inventory';

// ─── Result types ────────────────────────────────────────────────────

/** A temporal estimate derived from a RadarRecord. */
export interface RadarEstimate {
  /** Nullable ISO date (YYYY-MM-DD) or null if not estimable. */
  estimated_end_date: string | null;
  /** Status of the estimation attempt. */
  estimation_status: EstimationStatus;
  /**
   * Basis used for the computation:
   * - 'explicit_start': fecha_inicio + duration
   * - 'explicit_award_proxy': award/formalization + duration
   * - null: not estimable (insufficient data)
   */
  basis: Basis;
  /**
   * Reason for the status (human-readable).
   * "contractual_scenario" / "award_proxy_scenario" / "not_estimable: <reason>"
   */
  reason: string;
}

// ─── Main estimator ──────────────────────────────────────────────────

/**
 * Estimate the end date of a contract from a RadarRecord.
 *
 * Returns an RadarEstimate with the computed end date (if estimable),
 * the status/basis used, and a reason for the result.
 *
 * Rules:
 * 1. No valid duration or no date anchor → not_estimable, null end date.
 * 2. fecha_inicio + valid duration → contractual_scenario (start-based).
 * 3. fecha_adjudicacion or award-proxy fecha_fin + valid duration
 *    → award_proxy_scenario.
 * 4. fecha_fin alone (deadline) → not_estimable (it's not an anchor).
 * 5. prórroga is always unknown (not modeled here).
 * 6. confidence is always null (no calibration).
 * 7. No date arithmetic for missing start: if no fecha_inicio,
 *    don't use fecha_publicacion as start.
 */
export function estimate(record: RadarRecord): RadarEstimate {
  // Rule 1: no valid duration → not_estimable
  if (!record.duracion || record.duracion.valor <= 0 || !record.duracion.unidad) {
    return {
      estimated_end_date: null,
      estimation_status: 'not_estimable',
      basis: null,
      reason: 'no_duracion: missing or invalid duration (valor + required unit DAY/MON/ANN)',
    };
  }

  const { valor, unidad } = record.duracion;

  // Rule 2: explicit start → contractual_scenario
  if (record.fecha_inicio && isValidISODate(record.fecha_inicio)) {
    const endDate = computeEndDate(record.fecha_inicio, valor, unidad);
    return {
      estimated_end_date: endDate,
      estimation_status: 'contractual_scenario',
      basis: 'explicit_start',
      reason: `explicit_start + ${valor} ${unidad} from fecha_inicio ${record.fecha_inicio}`,
    };
  }

  // Rule 3: award proxy (fecha_adjudicacion or award-proxy fecha_fin)
  const awardAnchor = record.fecha_adjudicacion
    ?? findAwardProxyFechaFin(record);

  if (awardAnchor && isValidISODate(awardAnchor)) {
    const endDate = computeEndDate(awardAnchor, valor, unidad);
    const anchorLabel = record.fecha_adjudicacion
      ? 'fecha_adjudicacion'
      : 'fecha_fin (award proxy)';
    return {
      estimated_end_date: endDate,
      estimation_status: 'award_proxy_scenario',
      basis: 'explicit_award_proxy',
      reason: `${anchorLabel} + ${valor} ${unidad} (award proxy, prórroga unknown)`,
    };
  }

  // Rule 4: fecha_fin alone (deadline, presentation, etc.) → not_estimable
  if (record.fecha_fin) {
    return {
      estimated_end_date: null,
      estimation_status: 'not_estimable',
      basis: null,
      reason: `fecha_fin is a deadline/source-specific date, not an execution/award anchor`,
    };
  }

  // No usable date anchor at all
  return {
    estimated_end_date: null,
    estimation_status: 'not_estimable',
    basis: null,
    reason: 'no_date_anchor: no fecha_inicio, no fecha_adjudicacion, no award-proxy fecha_fin',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Find an award-proxy fecha_fin if the source supports it.
 * Returns the fecha_fin string only if:
 *  - The source is in AWARD_PROXY_FECHAFIN_SOURCES (TED, CATALUNYA, VALENCIA)
 *  - The evidence field (evidencia_campo_fuente) is in the source's allowed list
 *    from FECHA_FIN_MAPPING (e.g. DT_AWARD for TED, adjudication fields for CATALUNYA).
 *  - fecha_fin is not null.
 *
 * This prevents accepting any fecha_fin from a proxy source without
 * semantic evidence — a record from TED with evidencia_campo_fuente='unknown'
 * must NOT be treated as award-proxy.
 */
function findAwardProxyFechaFin(record: RadarRecord): string | null {
  if (record.fecha_fin === null) return null;
  if (!record.fuente) return null;

  const known: string[] = ['TED', 'CATALUNYA', 'VALENCIA'];
  if (!known.includes(record.fuente)) return null;

  // Require coherent evidence: the evidence field must be in the
  // source's allowed list from FECHA_FIN_MAPPING.
  const mapping = FECHA_FIN_MAPPING[record.fuente];
  if (!mapping || mapping.kind !== 'fields') return null;

  const campo = record.evidencia?.campo_fuente;
  if (!campo || !mapping.allowed.includes(campo)) return null;

  return record.fecha_fin;
}

/**
 * Compute end date from an anchor date and duration.
 * Uses the original unit: DAY → addDays, MON → addMonths, ANN → addYears.
 */
function computeEndDate(anchor: string, valor: number, unidad: DurationUnit): string {
  switch (unidad) {
    case 'DAY':
      return addDays(anchor, valor);
    case 'MON':
      return addMonths(anchor, valor);
    case 'ANN':
      return addYears(anchor, valor);
    default:
      // Should never reach here due to type system, but guard anyway.
      throw new Error(`Unknown duration unit: ${unidad}`);
  }
}