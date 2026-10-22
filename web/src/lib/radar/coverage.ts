/**
 * Coverage analysis for the radar dataset inventory.
 *
 * IMPORTANT distinction:
 * - SCHEMA PROJECTION (SOURCE_COLUMNS) describes what the unified view
 *   *projects* per source. It is NOT confirmed lineage and NOT data
 *   completeness.
 * - DATA COMPLETENESS must be measured over real records (records[]), not
 *   over the projection table. Coverage ratios here are computed from the
 *   actual records passed in, so they reflect data, not schema.
 *
 * Gate status: NO-GO if lineage is unconfirmed OR required estimation
 * fields have 0% completeness over real records. Synthetic fixtures are
 * NOT counted as real opportunities.
 */

import type { RadarRecord, SourceName } from './inventory';
import { SOURCE_COLUMNS, FECHA_FIN_MAPPING } from './inventory';

// ─── Types ───────────────────────────────────────────────────────────

export interface FieldCoverage {
  field: string;
  /** Number of records that have a non-null value for this field */
  recordsWithField: number;
  /** Total records in the dataset */
  totalRecords: number;
  /** Completeness ratio (data, not schema) */
  ratio: number;
  /** Whether this field is required for the estimation pipeline */
  required: boolean;
  /** Sources where records are missing this field */
  missingSources: SourceName[];
  /** Semantic note if field has source-specific meaning */
  semanticNote?: string;
}

export interface CoverageReport {
  /** Per-field coverage analysis */
  fields: FieldCoverage[];
  /** Total synthetic records (for denominator context) */
  syntheticRecords: number;
  /** Total real records (0 until production validation) */
  realRecords: number;
  /** Lineage status */
  lineageConfirmed: boolean;
  /** Gate verdict */
  gate: 'GO' | 'NO-GO';
  /** Reasons for NO-GO */
  blockers: string[];
}

// ─── Analysis ────────────────────────────────────────────────────────

const ALL_SOURCES: SourceName[] = [
  'PLACSP', 'PLACE', 'TED', 'ANDALUCIA', 'CATALUNYA', 'GALICIA',
  'MADRID', 'EUSKADI', 'ASTURIAS', 'VALENCIA', 'BOE',
];

const REQUIRED_FIELDS = [
  'duracion',
  'fecha_inicio',
  'evidencia',
  'adjudicatario',
  'importe_adjudicacion',
];

/**
 * Analyze field completeness across the actual records.
 * Denominator = total records (real + synthetic), so synthetic fixtures
 * inflate the ratio. Use realRecords for the true production picture.
 */
export function analyzeCoverage(records: RadarRecord[]): CoverageReport {
  const blockers: string[] = [];
  const fields: FieldCoverage[] = [];
  const total = records.length;

  const recordHas = (rec: RadarRecord, field: string): boolean => {
    switch (field) {
      case 'duracion': return rec.duracion !== null;
      case 'fecha_inicio': return rec.fecha_inicio !== null;
      case 'evidencia': return !!(rec.evidencia?.campo_fuente);
      case 'adjudicatario': return rec.adjudicatario !== null;
      case 'importe_adjudicacion': return rec.importe_adjudicacion !== null;
      default: return true;
    }
  };

  const coverageFor = (field: string, required: boolean, note?: string): FieldCoverage => {
    let withField = 0;
    const missingBySource = new Map<SourceName, number>();
    for (const rec of records) {
      if (recordHas(rec, field)) withField++;
      else missingBySource.set(rec.fuente, (missingBySource.get(rec.fuente) || 0) + 1);
    }
    const missingSources: SourceName[] = [...missingBySource.keys()];
    return {
      field,
      recordsWithField: withField,
      totalRecords: total,
      ratio: total === 0 ? 0 : withField / total,
      required,
      missingSources,
      semanticNote: note,
    };
  };

  fields.push(coverageFor('duracion', true, 'Duration (valor+unidad) — required for estimation'));
  fields.push(coverageFor('fecha_inicio', true, 'Explicit execution start — NOT inferred from DT_DISPATCH'));
  fields.push(coverageFor('evidencia', true, 'campo_fuente provenance per record'));
  fields.push(coverageFor('adjudicatario', true, 'Historical, NOT current provider'));
  fields.push(coverageFor('importe_adjudicacion', true, 'Historical, NOT future/current renewal amount'));

  // Data-completeness blockers (only over real records; synthetic excluded)
  const realRecords = records.filter(r => !r.es_sintetico);
  if (realRecords.length > 0) {
    const realDur = realRecords.filter(r => r.duracion !== null).length / realRecords.length;
    const realInicio = realRecords.filter(r => r.fecha_inicio !== null).length / realRecords.length;
    if (realDur === 0) blockers.push('duracion completeness 0% over real records');
    if (realInicio === 0) blockers.push('fecha_inicio completeness 0% over real records');
  } else {
    blockers.push('0 real records — cannot measure data completeness');
  }

  // Lineage check
  const lineageConfirmed = false; // production schema NOT confirmed
  if (!lineageConfirmed) {
    blockers.push('Production schema NOT confirmed — lineage from scripts only');
  }

  // Count synthetic vs real
  const syntheticRecords = records.filter(r => r.es_sintetico).length;

  return {
    fields,
    syntheticRecords,
    realRecords: realRecords.length,
    lineageConfirmed,
    gate: blockers.length === 0 ? 'GO' : 'NO-GO',
    blockers,
  };
}

/**
 * Schema projection check: per source, does the unified view expose the
 * field? Purely descriptive — NOT data completeness.
 */
export function schemaProjection(): Record<SourceName, ReturnType<typeof sourceHas>> {
  const out = {} as Record<SourceName, ReturnType<typeof sourceHas>>;
  for (const src of ALL_SOURCES) out[src] = sourceHas(src);
  return out;
}

function sourceHas(src: SourceName) {
  const cols = SOURCE_COLUMNS[src];
  const mapping = FECHA_FIN_MAPPING[src];
  return {
    hasAdjudicatario: cols.hasAdjudicatario,
    hasImporteAdjudicacion: cols.hasImporteAdjudicacion,
    hasCpv: cols.hasCpv,
    hasUrl: cols.hasUrl,
    fechaFin: mapping.kind === 'none' ? 'none' : mapping.kind === 'pass-through' ? 'pass-through' : 'field(s)',
  };
}

/**
 * Deduplication check. Dedup unit = fuente + id + lote + version (when
 * available), NOT id alone — the same id may recur across sources/lots.
 * Returns a description of duplicates found.
 */
export function findDuplicates(records: RadarRecord[]): string[] {
  const seen = new Map<string, number>();
  const dupes: string[] = [];

  for (const rec of records) {
    const key = dedupKey(rec);
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count === 1) dupes.push(key); // report on second occurrence
  }

  return dupes;
}

/** Build the dedup key: fuente|id|lote|version. */
export function dedupKey(rec: RadarRecord): string {
  return [rec.fuente, rec.id, rec.lote ?? '', rec.version ?? ''].join('|');
}

/**
 * Unit validation: check all durations have valid, finite units.
 */
export function validateAllUnits(records: RadarRecord[]): string[] {
  const issues: string[] = [];

  for (const rec of records) {
    if (!rec.duracion) continue;
    if (!['DAY', 'MON', 'ANN'].includes(rec.duracion.unidad)) {
      issues.push(`${rec.id}: invalid duration unit "${rec.duracion.unidad}"`);
    }
    if (typeof rec.duracion.valor !== 'number' || !Number.isFinite(rec.duracion.valor) || rec.duracion.valor <= 0) {
      issues.push(`${rec.id}: duration valor must be finite and > 0, got ${rec.duracion.valor}`);
    }
  }

  return issues;
}

/**
 * Missing field check: identify records with required fields missing.
 */
export function findMissingFields(records: RadarRecord[]): string[] {
  const issues: string[] = [];

  for (const rec of records) {
    if (!rec.id) issues.push('Record missing id');
    if (!rec.fuente) issues.push(`${rec.id}: missing fuente`);
    if (!rec.organismo) issues.push(`${rec.id}: missing organismo`);
    if (!rec.objeto) issues.push(`${rec.id}: missing objeto`);
    if (rec.es_sintetico === undefined) issues.push(`${rec.id}: missing es_sintetico flag`);
  }

  return issues;
}
