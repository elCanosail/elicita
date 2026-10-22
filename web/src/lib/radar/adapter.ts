/**
 * Source adapter for the Radar temporal estimator.
 *
 * Transforms a raw source record (per-source schema) into the canonical
 * RadarRecord contract. Validates semantics: fecha_fin meaning, DT_DISPATCH
 * is NOT start, duration must have unit, no auto-aggregation of lots, etc.
 *
 * Contract rules enforced here:
 * - fecha_fin is NOT treated as start/expiry/award generically.
 * - DT_DISPATCH is publication, NOT execution start.
 * - duration without valid unit → not_estimable.
 * - No +365 fallback when duration is missing.
 * - Each record = one contract/lote/version unit. No aggregation.
 * - prórroga = unknown (absent or unknown; never defaults to 0).
 * - confidence stays null.
 */

import type {
  RadarRecord,
  SourceName,
  EstimationStatus,
  DurationUnit,
  Basis,
} from './inventory';
import { AWARD_PROXY_FECHAFIN_SOURCES, FECHA_FIN_MAPPING } from './inventory';

// ─── Raw source record shape (per-source) ────────────────────────────

/**
 * Minimal raw record accepted by the adapter.
 * Each source can contribute a subset of these fields.
 */
export interface RawSourceRecord {
  id: string;
  lote?: string | null;
  version?: string | null;
  fuente: SourceName;
  expediente: string;
  organismo: string;
  objeto: string;
  cpv?: string | null;
  importe_licitacion?: number | null;
  importe_adjudicacion?: number | null;
  adjudicatario?: string | null;
  fecha_publicacion?: string | null;
  fecha_adjudicacion?: string | null;
  fecha_inicio?: string | null;
  fecha_fin?: string | null;
  url?: string | null;
  /** Duration value, may be null if source doesn't track it. */
  duracion_valor?: number | null;
  /** Duration unit from source: DAY, HOUR, WEEK, MONTH, ANNO, ANN, etc. */
  duracion_unidad?: string | null;
  /**
   * Explicit evidence field name that anchors a fecha_fin value.
   * E.g. "DT_AWARD", "fecha_limite", "fecha_formalizacion".
   */
  evidencia_campo_fuente?: string | null;
  evidencia_url?: string | null;
  /** Whether this record comes from a synthetic test fixture. */
  es_sintetico?: boolean;
}

// ─── Unit normalization ──────────────────────────────────────────────

/** Map various source units to canonical DAY/MON/ANN. */
const UNIT_MAP: Record<string, DurationUnit | null> = {
  DAY: 'DAY',
  DAYS: 'DAY',
  DIA: 'DAY',
  DIAS: 'DAY',
  HOUR: null,   // rejected — too granular for contract duration
  HOURS: null,
  WEEK: null,   // rejected — not in contract
  WEEKS: null,
  SEMANA: null,
  SEMANAS: null,
  MONTH: 'MON',
  MONTHS: 'MON',
  MES: 'MON',
  MESES: 'MON',
  ANN: 'ANN',
  ANNO: 'ANN',
  ANOS: 'ANN',
  AÑO: 'ANN',
  AÑOS: 'ANN',
  YEAR: 'ANN',
  YEARS: 'ANN',
};

/**
 * Normalize a duration unit string to canonical DAY/MON/ANN.
 * Returns null if the unit is not recognized or not allowed.
 */
export function normalizeUnit(raw: string | null): DurationUnit | null {
  if (!raw) return null;
  return UNIT_MAP[raw.toUpperCase()] ?? null;
}

// ─── Known source allowlist ──────────────────────────────────────────

/**
 * Explicit allowlist of known Radar sources.
 * Mirrors the SourceName union in inventory.ts so the adapter can
 * validate without importing the union (avoids circular deps).
 */
const KNOWN_SOURCES: ReadonlySet<SourceName> = new Set([
  'PLACSP', 'PLACE', 'TED', 'ANDALUCIA', 'CATALUNYA',
  'GALICIA', 'MADRID', 'EUSKADI', 'ASTURIAS', 'VALENCIA', 'BOE',
]);

// ─── Adaptability check ──────────────────────────────────────────────

/**
 * Determine if a raw record can be adapted.
 * Required: id, fuente (known source), expediente, organismo, objeto.
 */
export function isAdaptable(raw: RawSourceRecord): boolean {
  if (!raw.id || typeof raw.id !== 'string') return false;
  if (!KNOWN_SOURCES.has(raw.fuente)) return false;
  if (!raw.expediente) return false;
  if (!raw.organismo) return false;
  if (!raw.objeto) return false;
  return true;
}

// ─── Evidence validation ─────────────────────────────────────────────

/**
 * Check that the evidence field is allowed for the source.
 * For sources with fecha_fin, the evidencia_campo_fuente must be
 * in the source's allowed list (from FECHA_FIN_MAPPING).
 */
export function isValidEvidenceField(
  fuente: SourceName,
  campoFuente: string | null,
): boolean {
  if (!campoFuente) return false;
  const mapping = FECHA_FIN_MAPPING[fuente];
  if (!mapping) return false;
  if (mapping.kind === 'none') {
    // Source has no fecha_fin column — evidence cannot reference it
    return campoFuente === 'N/A (source lacks fecha_fin column)';
  }
  if (mapping.kind === 'pass-through') {
    // BOE: pass-through, cannot validate without lineage
    return true;
  }
  // fields: campo must be in the allowed list
  return mapping.allowed.includes(campoFuente);
}

/**
 * Check that the evidence field is an allowed award-proxy anchor
 * for the source. Only TED/CATALUNYA/VALENCIA can use award-proxy,
 * and only with their specific allowed evidence fields.
 */
export function isAwardProxyEvidence(
  fuente: SourceName,
  campoFuente: string | null,
): boolean {
  if (!AWARD_PROXY_FECHAFIN_SOURCES.has(fuente)) return false;
  const mapping = FECHA_FIN_MAPPING[fuente];
  if (!mapping || mapping.kind !== 'fields') return false;
  return mapping.allowed.includes(campoFuente ?? '');
}

// ─── Main adapter ────────────────────────────────────────────────────

/**
 * Adapt a raw source record into a RadarRecord.
 *
 * Applies all contract rules: fecha_fin semantics, duration unit
 * normalization, estimation_status derivation, and evidence tracking.
 *
 * @throws Error if isAdaptable(raw) is false or if a required field is missing.
 */
export function adapt(raw: RawSourceRecord): RadarRecord {
  if (!isAdaptable(raw)) {
    throw new Error(`Record is not adaptable: id=${raw.id ?? '(none)'}`);
  }

  // Duration
  const duracionRaw = raw.duracion_valor ?? null;
  const unidadRaw = raw.duracion_unidad ?? null;
  const duracion = normalizeUnit(unidadRaw)
    ? duracionRaw !== null && typeof duracionRaw === 'number' && duracionRaw > 0
      ? { valor: duracionRaw, unidad: normalizeUnit(unidadRaw) as DurationUnit }
      : null
    : null; // unit not recognized or invalid → duration unusable

  // Evidencia
  const campoFuente = raw.evidencia_campo_fuente ?? (raw.fecha_fin ? 'unknown' : null);

  // Derive estimation_status and basis
  const { estimation_status, basis } = deriveStatus(raw, duracion);

  return {
    id: raw.id,
    lote: raw.lote ?? null,
    version: raw.version ?? null,
    fuente: raw.fuente,
    expediente: raw.expediente,
    organismo: raw.organismo,
    objeto: raw.objeto,
    cpv: raw.cpv ?? null,
    importe_licitacion: raw.importe_licitacion ?? null,
    importe_adjudicacion: raw.importe_adjudicacion ?? null,
    adjudicatario: raw.adjudicatario ?? null,
    fecha_publicacion: raw.fecha_publicacion ?? null,
    fecha_adjudicacion: raw.fecha_adjudicacion ?? null,
    fecha_inicio: raw.fecha_inicio ?? null,
    fecha_fin: raw.fecha_fin ?? null,
    url: raw.url ?? null,
    duracion,
    estimation_status,
    estimated_end_date: null, // estimator fills this
    confidence: null, // always null per contract
    basis,
    evidencia: {
      campo_fuente: campoFuente ?? 'unknown',
      url: raw.evidencia_url ?? raw.url ?? undefined,
    },
    es_sintetico: raw.es_sintetico ?? false,
  };
}

// ─── Status derivation ───────────────────────────────────────────────

/**
 * Derive estimation_status and basis from a raw record + duration.
 *
 * Rules (from radar-temporal-contract-review.md):
 * 1. No valid duration or no start/award date → not_estimable
 * 2. Explicit start + valid duration → contractual_scenario
 * 3. Only award (fecha_adjudicacion or fecha_fin from award proxy source)
 *    + valid duration → award_proxy_scenario
 * 4. fecha_fin from a deadline source (PLACSP/PLACE/ANDALUCIA/etc.)
 *    is NOT an award → not_estimable (unless fecha_adjudicacion also present)
 * 5. DT_DISPATCH in fecha_publicacion is publication, NOT start.
 * 6. Award-proxy fecha_fin requires coherent evidence: the evidence field
 *    must be in the source's allowed list (e.g. DT_AWARD for TED).
 *    Unknown/no evidence → not_estimable.
 */
function deriveStatus(
  raw: RawSourceRecord,
  duracion: RadarRecord['duracion'],
): { estimation_status: EstimationStatus; basis: Basis } {
  // No duration (null, invalid unit, or missing valor) → not_estimable
  if (!duracion) {
    return { estimation_status: 'not_estimable', basis: null };
  }

  // Explicit execution start present
  if (raw.fecha_inicio) {
    return {
      estimation_status: 'contractual_scenario',
      basis: 'explicit_start',
    };
  }

  // Check for award anchor:
  // a) Explicit fecha_adjudicacion field
  // b) fecha_fin from a source whose fecha_fin maps to award/formalization
  //    AND evidence field is in the source's allowed list
  //    (TED: DT_AWARD, CATALUNYA: adjudication fields, VALENCIA: formalization)
  const hasExplicitAdjudicacion = !!raw.fecha_adjudicacion;
  const hasAwardProxyFechaFin =
    !!raw.fecha_fin &&
    isAwardProxyEvidence(raw.fuente, raw.evidencia_campo_fuente ?? null);

  if (hasExplicitAdjudicacion || hasAwardProxyFechaFin) {
    return {
      estimation_status: 'award_proxy_scenario',
      basis: 'explicit_award_proxy',
    };
  }

  // No start, no award anchor, but has fecha_fin — it's a deadline, not usable
  if (raw.fecha_fin) {
    return { estimation_status: 'not_estimable', basis: null };
  }

  // Nothing usable
  return { estimation_status: 'not_estimable', basis: null };
}