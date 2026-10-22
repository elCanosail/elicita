/**
 * Radar synthetic data adapter (T6 — injected, not production).
 *
 * Provides a queryable interface over synthetic RadarRecord fixtures.
 * All records are synthetic and marked with es_sintetico: true.
 *
 * When real data lineage is confirmed (future), this module can be
 * wired to production DuckDB queries by swapping the data source.
 * The contract schema (contract.ts) remains the same — only the
 * data provider changes.
 *
 * Current state: NO-GO gate (lineage unconfirmed) → safe_empty
 * responses until production validation is achieved.
 *
 * Source: web/src/lib/radar/injection.ts
 */

import type { RadarRecord } from './inventory';
import type { RadarOpportunity } from './contract';
import { RADAR_FIXTURES } from './fixtures';

// ─── Gate: production readiness ──────────────────────────────────────

/**
 * Whether this adapter is allowed to return real estimable records.
 * Currently false — production lineage is unconfirmed (NO-GO gate).
 * When set to true, the adapter returns the full queryable result.
 */
const LINEAGE_CONFIRMED = false;

/**
 * Human-readable explanation for why data is safe-empty.
 */
const SAFE_EXPLANATION =
  'Línea base no confirmada: la procedencia de datos de producción ' +
  'no ha sido validada en read-only. Solo se muestran registros ' +
  'previamente estimables con evidencia verificable. ' +
  'Consulte /api/radar/coverage para el estado de cobertura.';

// ─── Convert RadarRecord → RadarOpportunity (typed cast) ─────────────

/**
 * Convert a validated RadarRecord into a RadarOpportunity.
 * The contract type is identical to the record type — this is
 * primarily a type-level assertion plus a sanity check.
 */
function toOpportunity(rec: RadarRecord): RadarOpportunity {
  // Sanity: confidence must be null (contract rule)
  if (rec.confidence !== null) {
    // Should never happen — inventory.validateRecord catches this.
    // But guard defensively.
    throw new Error(
      `Record ${rec.id}: confidence must be null, got ${rec.confidence}`
    );
  }

  return {
    id: rec.id,
    lote: rec.lote ?? undefined,
    version: rec.version ?? undefined,
    fuente: rec.fuente,
    expediente: rec.expediente,
    organismo: rec.organismo,
    objeto: rec.objeto,
    cpv: rec.cpv,
    importe_licitacion: rec.importe_licitacion,
    importe_adjudicacion: rec.importe_adjudicacion,
    adjudicatario: rec.adjudicatario,
    fecha_publicacion: rec.fecha_publicacion,
    fecha_adjudicacion: rec.fecha_adjudicacion,
    fecha_inicio: rec.fecha_inicio,
    fecha_fin: rec.fecha_fin,
    url: rec.url,
    duracion: rec.duracion,
    estimation_status: rec.estimation_status,
    estimated_end_date: rec.estimated_end_date,
    confidence: null,
    basis: rec.basis,
    evidencia: {
      campo_fuente: rec.evidencia.campo_fuente,
      url: rec.evidencia.url,
      observed_at: rec.evidencia.observed_at,
    },
    es_sintetico: rec.es_sintetico,
  };
}

// ─── Query interface ─────────────────────────────────────────────────

export interface RadarQueryParams {
  fuente?: string;
  estimation_status?: string;
  cpv?: string;
  organismo?: string;
  limit?: number;
  offset?: number;
}

/**
 * Query the synthetic dataset.
 *
 * When LINEAGE_CONFIRMED is false, returns a safe-empty response
 * with explanation. When true, applies filters and returns matching
 * opportunities.
 */
export function queryRadar(
  params: RadarQueryParams
): {
  opportunities: RadarOpportunity[];
  total: number;
  lineageConfirmed: boolean;
  safeEmpty: boolean;
} {
  if (!LINEAGE_CONFIRMED) {
    return {
      opportunities: [],
      total: 0,
      lineageConfirmed: false,
      safeEmpty: true,
    };
  }

  let records = [...RADAR_FIXTURES];

  // Apply filters
  if (params.fuente) {
    records = records.filter(r => r.fuente === params.fuente);
  }
  if (params.estimation_status) {
    records = records.filter(r => r.estimation_status === params.estimation_status);
  }
  if (params.cpv) {
    const prefix = params.cpv.toUpperCase();
    records = records.filter(r => r.cpv?.toUpperCase().startsWith(prefix));
  }
  if (params.organismo) {
    const q = params.organismo.toLowerCase();
    records = records.filter(r => r.organismo.toLowerCase().includes(q));
  }

  // Pagination
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 20;
  const paged = records.slice(offset, offset + limit);

  return {
    opportunities: paged.map(toOpportunity),
    total: records.length,
    lineageConfirmed: true,
    safeEmpty: false,
  };
}

/**
 * Check if the current lineage state is confirmed.
 */
export function isLineageConfirmed(): boolean {
  return LINEAGE_CONFIRMED;
}

/**
 * Get the safe-empty explanation.
 */
export function getSafeExplanation(): string {
  return SAFE_EXPLANATION;
}