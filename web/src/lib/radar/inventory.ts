/**
 * Radar dataset inventory model.
 *
 * Derived from: web/scripts/create_unified_view.sql (lineage evidence).
 * This is NOT a production schema confirmation — production schema
 * remains UNCONFIRMED pending read-only validation (see Gate below).
 *
 * Semantic contract per radar-temporal-contract-review.md:
 * - fecha_fin is NOT vencimiento/award/execution_start generically
 * - DT_DISPATCH is publication, NOT execution start
 * - No +365 days when duration is missing
 * - confidence: null until calibration exists
 * - Units: DAY | MON | ANN, original normalized
 * - estimation_status: not_estimable | contractual_scenario | award_proxy_scenario
 * - Unknown/absent values are null (not fake zeros); no source→adjudication
 *   mapping without verified lineage. Estimation defaults to not_estimable
 *   rather than a fabricated renewal date.
 *
 * NOTE: the per-source record counts previously in comments were unverified
 * and are removed. They are NOT confirmed until read-only validation.
 */

// ─── Canonical source set (from unified view projection) ─────────────

export type SourceName =
  | 'PLACSP'    // nacional, archivo_origen NOT LIKE %PLACE%
  | 'PLACE'     // nacional/calidad subset marked archivo_origen LIKE %PLACE%
  | 'TED'
  | 'ANDALUCIA'
  | 'CATALUNYA'
  | 'GALICIA'
  | 'MADRID'
  | 'EUSKADI'
  | 'ASTURIAS'
  | 'VALENCIA'
  | 'BOE';

export type DurationUnit = 'DAY' | 'MON' | 'ANN';

export type EstimationStatus =
  | 'not_estimable'
  | 'contractual_scenario'
  | 'award_proxy_scenario';

export type Basis = 'explicit_start' | 'explicit_award_proxy' | null;

/** Per-source semantic notes on fecha_fin mapping */
export const FECHA_FIN_SEMANTICS: Record<SourceName, string> = {
  PLACSP:    'fecha_limite (presentation deadline) — NOT award/execution',
  PLACE:     'fecha_limite (presentation deadline) — NOT award/execution',
  TED:       'DT_AWARD (adjudication date) — NOT start of execution',
  ANDALUCIA: 'fecha_limite_presentacion (presentation deadline) — NOT award',
  CATALUNYA: 'DATA_PUB_ADJUDICACIO / DATA_PUBLICACIO_ADJUDICACIO (adjudication publication)',
  GALICIA:   'NULL — no fecha_fin available',
  MADRID:    'NULL — no fecha_fin available',
  EUSKADI:   'Mixed: fecha_limite_presentacion OR fecha_adjudicacion OR fecha_formalizacion',
  ASTURIAS:  'NULL — no fecha_fin available',
  VALENCIA:  'FECHA_FORMALIZACION (formalization date)',
  BOE:       'Pass-through from source table (lineage unconfirmed)',
};

/**
 * Per-source mapping of which field(s) legitimately back fecha_fin.
 * `fields`: the known source column(s) allowed to populate fecha_fin.
 * `none`: the source has no fecha_fin column; fecha_fin must be null.
 * `pass-through`: field(s) unknown — cannot validate without lineage.
 */
export type FechaFinMapping =
  | { kind: 'fields'; allowed: string[] }
  | { kind: 'none' }
  | { kind: 'pass-through' };

export const FECHA_FIN_MAPPING: Record<SourceName, FechaFinMapping> = {
  PLACSP:    { kind: 'fields', allowed: ['fecha_limite'] },
  PLACE:     { kind: 'fields', allowed: ['fecha_limite'] },
  TED:       { kind: 'fields', allowed: ['DT_AWARD'] },
  ANDALUCIA: { kind: 'fields', allowed: ['fecha_limite_presentacion'] },
  CATALUNYA: { kind: 'fields', allowed: ['DATA_PUB_ADJUDICACIO', 'DATA_PUBLICACIO_ADJUDICACIO', 'DATA_PUBLICACIO_FORMALITZACIO', 'DATA_FORMALIT'] },
  GALICIA:   { kind: 'none' },
  MADRID:    { kind: 'none' },
  EUSKADI:   { kind: 'fields', allowed: ['fecha_límite_de_presentación', 'contratacion_fecha_limite_presentacion', 'fecha_de_adjudicacion', 'fecha_de_formalizacion'] },
  ASTURIAS:  { kind: 'none' },
  VALENCIA:  { kind: 'fields', allowed: ['FECHA_FORMALIZACION'] },
  BOE:       { kind: 'pass-through' },
};

/**
 * Column presence per source — SCHEMA PROJECTION from the unified view
 * script, NOT confirmed lineage. This is what the view *projects*; it is
 * NOT evidence that production tables expose these columns. Do not treat
 * this as data completeness — see coverage.ts which measures real records.
 */
export interface SourceColumns {
  hasAdjudicatario: boolean;
  hasImporteAdjudicacion: boolean;
  hasFechaFin: boolean;
  hasCpv: boolean;
  hasUrl: boolean;
}

export const SOURCE_COLUMNS: Record<SourceName, SourceColumns> = {
  PLACSP:    { hasAdjudicatario: true,  hasImporteAdjudicacion: true,  hasFechaFin: true,  hasCpv: true,  hasUrl: true  },
  PLACE:     { hasAdjudicatario: true,  hasImporteAdjudicacion: true,  hasFechaFin: true,  hasCpv: true,  hasUrl: true  },
  TED:       { hasAdjudicatario: true,  hasImporteAdjudicacion: true,  hasFechaFin: true,  hasCpv: true,  hasUrl: false },
  ANDALUCIA: { hasAdjudicatario: false, hasImporteAdjudicacion: true,  hasFechaFin: true,  hasCpv: true,  hasUrl: true  },
  CATALUNYA: { hasAdjudicatario: true,  hasImporteAdjudicacion: true,  hasFechaFin: true,  hasCpv: true,  hasUrl: true  },
  GALICIA:   { hasAdjudicatario: true,  hasImporteAdjudicacion: false, hasFechaFin: false, hasCpv: false, hasUrl: false },
  MADRID:    { hasAdjudicatario: true,  hasImporteAdjudicacion: true,  hasFechaFin: false, hasCpv: false, hasUrl: false },
  EUSKADI:   { hasAdjudicatario: true,  hasImporteAdjudicacion: true,  hasFechaFin: true,  hasCpv: true,  hasUrl: true  },
  ASTURIAS:  { hasAdjudicatario: true,  hasImporteAdjudicacion: false, hasFechaFin: false, hasCpv: true,  hasUrl: false },
  VALENCIA:  { hasAdjudicatario: true,  hasImporteAdjudicacion: true,  hasFechaFin: true,  hasCpv: true,  hasUrl: true  },
  BOE:       { hasAdjudicatario: true,  hasImporteAdjudicacion: true,  hasFechaFin: true,  hasCpv: true,  hasUrl: true  },
};

// ─── Record types ────────────────────────────────────────────────────

export interface RadarRecord {
  id: string;
  /** Contract lot, when available (dedup unit, not an aggregate). */
  lote?: string | null;
  /** Contract version, when available (dedup unit). */
  version?: string | null;
  fuente: SourceName;
  expediente: string;
  organismo: string;
  objeto: string;
  cpv: string | null;
  importe_licitacion: number | null;
  importe_adjudicacion: number | null;  // historical, NOT future/current
  adjudicatario: string | null;         // historical, NOT current provider
  fecha_publicacion: string | null;      // ISO date or null
  fecha_adjudicacion: string | null;     // when available, separate field
  fecha_inicio: string | null;           // execution start, when explicit
  fecha_fin: string | null;              // semantic per FECHA_FIN_SEMANTICS
  url: string | null;
  duracion: { valor: number; unidad: DurationUnit } | null;
  estimation_status: EstimationStatus;
  estimated_end_date: string | null;     // nullable, NOT renamed to "renovación"
  confidence: null;                      // always null until calibration
  basis: Basis;
  evidencia: { campo_fuente: string; url?: string; observed_at?: string };
  es_sintetico: boolean;                 // TRUE for test fixtures
}

// ─── Validation helpers ──────────────────────────────────────────────

export const DURATION_UNIT_VALID: ReadonlySet<string> = new Set(['DAY', 'MON', 'ANN']);

/**
 * Sources whose fecha_fin maps to an award/formalization date (NOT a
 * presentation deadline). Used to decide whether a fecha_fin can anchor an
 * award_proxy_scenario. EUSKADI is excluded: its fecha_fin is mixed and may
 * be a deadline, so it cannot be assumed an award proxy without per-record
 * evidence. BOE is pass-through (lineage unconfirmed).
 */
export const AWARD_PROXY_FECHAFIN_SOURCES: ReadonlySet<SourceName> = new Set([
  'TED',
  'CATALUNYA',
  'VALENCIA',
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict ISO date (YYYY-MM-DD) check that rejects e.g. 2024-13-40. */
export function isValidISODate(s: string | null): boolean {
  if (s === null) return true;
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Round-trip to reject overflow (e.g. Feb 30).
  return d.toISOString().slice(0, 10) === s;
}

/**
 * Validate a duration object. Returns error string or null.
 * Rejects NaN and Infinity (finite > 0 required).
 */
export function validateDuration(d: RadarRecord['duracion']): string | null {
  if (d === null) return null; // null is valid (not_estimable)
  if (typeof d.valor !== 'number' || !Number.isFinite(d.valor)) {
    return 'duration.valor must be a finite number';
  }
  if (d.valor <= 0) return 'duration.valor must be > 0';
  if (!DURATION_UNIT_VALID.has(d.unidad)) {
    return `duration.unidad must be one of DAY/MON/ANN, got ${d.unidad}`;
  }
  return null;
}

/**
 * Validate that confidence is always null (no uncalibrated confidence).
 */
export function validateConfidence(record: RadarRecord): string | null {
  if (record.confidence !== null) return 'confidence must be null until calibration exists';
  return null;
}

/**
 * Validate that fecha_fin matches its source-specific allowed field(s).
 * Rejects: fecha_fin set on a source with no fecha_fin column, or a
 * campo_fuente not in the allowed list for that source.
 */
export function validateFechaFinSemantics(record: RadarRecord): string | null {
  if (!record.fecha_fin) return null; // null fecha_fin is valid
  const mapping = FECHA_FIN_MAPPING[record.fuente];
  if (!mapping) return `Unknown source ${record.fuente}`;

  if (mapping.kind === 'none') {
    return `${record.fuente} has no fecha_fin column but fecha_fin is set (${record.fecha_fin})`;
  }
  if (mapping.kind === 'pass-through') {
    // BOE passes through from source; cannot validate without lineage.
    return `${record.fuente} fecha_fin is pass-through; lineage unconfirmed`;
  }

  const campo = record.evidencia?.campo_fuente;
  if (!campo) {
    return 'fecha_fin present but evidencia.campo_fuente missing';
  }
  if (!mapping.allowed.includes(campo)) {
    return `${record.fuente} fecha_fin campo_fuente "${campo}" not in allowed [${mapping.allowed.join(', ')}]`;
  }
  return null;
}

/**
 * Full record validation. Returns array of error strings (empty = valid).
 * Enforces status/basis/date/start/duration coherence and invokes
 * fecha_fin semantics.
 */
export function validateRecord(record: RadarRecord): string[] {
  const errors: string[] = [];

  if (!record.id) errors.push('id is required');
  if (!record.fuente) errors.push('fuente is required');
  if (!record.expediente) errors.push('expediente is required');
  if (!record.organismo) errors.push('organismo is required');
  if (!record.objeto) errors.push('objeto is required');

  const durErr = validateDuration(record.duracion);
  if (durErr) errors.push(durErr);

  const confErr = validateConfidence(record);
  if (confErr) errors.push(confErr);

  const fechaSemErr = validateFechaFinSemantics(record);
  if (fechaSemErr) errors.push(fechaSemErr);

  // estimation_status must be valid
  if (!['not_estimable', 'contractual_scenario', 'award_proxy_scenario'].includes(record.estimation_status)) {
    errors.push(`invalid estimation_status: ${record.estimation_status}`);
  }

  // basis must be valid
  if (record.basis !== null && !['explicit_start', 'explicit_award_proxy'].includes(record.basis)) {
    errors.push(`invalid basis: ${record.basis}`);
  }

  // evidencia required
  if (!record.evidencia || !record.evidencia.campo_fuente) {
    errors.push('evidencia.campo_fuente is required');
  }

  // synthetic records must be labeled
  if (record.es_sintetico === undefined) {
    errors.push('es_sintetico flag must be explicitly set');
  }

  // ── Date validity ────────────────────────────────────────────────
  for (const field of ['fecha_publicacion', 'fecha_adjudicacion', 'fecha_inicio', 'fecha_fin', 'estimated_end_date'] as const) {
    const val = record[field];
    if (val !== null && !isValidISODate(val)) {
      errors.push(`${field} must be a valid ISO date (YYYY-MM-DD), got ${val}`);
    }
  }

  // ── status/basis/date/duration coherence ─────────────────────────
  const est = record.estimation_status;
  const basis = record.basis;

  if (est === 'not_estimable') {
    if (record.estimated_end_date !== null) {
      errors.push('not_estimable cannot set estimated_end_date');
    }
    if (basis !== null) {
      errors.push('not_estimable cannot set a basis');
    }
  }

  if (est === 'contractual_scenario') {
    if (basis !== 'explicit_start') errors.push('contractual_scenario requires basis=explicit_start');
    if (!record.fecha_inicio) errors.push('contractual_scenario requires fecha_inicio');
    if (!record.duracion) errors.push('contractual_scenario requires duracion');
  }

  if (est === 'award_proxy_scenario') {
    if (basis !== 'explicit_award_proxy') errors.push('award_proxy_scenario requires basis=explicit_award_proxy');
    if (!record.duracion) errors.push('award_proxy_scenario requires duracion');
    const hasAwardAnchor =
      !!record.fecha_adjudicacion ||
      (!!record.fecha_fin && AWARD_PROXY_FECHAFIN_SOURCES.has(record.fuente));
    if (!hasAwardAnchor) errors.push('award_proxy_scenario requires an explicit award/formalization anchor date');
  }

  if (basis === 'explicit_start' && !record.fecha_inicio) {
    errors.push('basis=explicit_start requires fecha_inicio');
  }
  if (basis === 'explicit_award_proxy') {
    const hasAwardAnchor =
      !!record.fecha_adjudicacion ||
      (!!record.fecha_fin && AWARD_PROXY_FECHAFIN_SOURCES.has(record.fuente));
    if (!hasAwardAnchor) errors.push('basis=explicit_award_proxy requires an award/formalization anchor date');
  }

  if (record.estimated_end_date !== null) {
    if (!record.duracion) errors.push('estimated_end_date requires duracion');
    else if (validateDuration(record.duracion) !== null) errors.push('estimated_end_date requires a valid duracion');
    if (basis === null) errors.push('estimated_end_date requires a basis');
    if (est === 'not_estimable') errors.push('estimated_end_date contradicts not_estimable');
  }

  return errors;
}
