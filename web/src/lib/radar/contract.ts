/**
 * Radar Opportunities — contract-first Zod schema (T6).
 *
 * Defines the minimal, stable API contract for querying Radar
 * temporal-estimation opportunities. Only opportunities that have
 * been *previously estimable* (have a valid duration + date anchor)
 * are exposed.
 *
 * Contract rules:
 * - estimation_status: never fabricated; always one of the three
 *   valid states derived from the adapter.
 * - estimated_end_date: nullable ISO date or null.
 * - basis: explicit_start | explicit_award_proxy | null.
 * - confidence: always null (no calibration exists).
 * - evidencia: per-record provenance anchor.
 * - When real data lineage is unverified, the endpoint returns
 *   an empty list with a safe explanation — never infers data.
 *
 * Source: web/src/lib/radar/contract.ts
 */

import { z } from 'zod';

// ─── Source name (must match inventory.ts SourceName) ────────────────

export const RadarSourceSchema = z.enum([
  'PLACSP', 'PLACE', 'TED', 'ANDALUCIA', 'CATALUNYA',
  'GALICIA', 'MADRID', 'EUSKADI', 'ASTURIAS', 'VALENCIA', 'BOE',
]);

export type RadarSource = z.infer<typeof RadarSourceSchema>;

// ─── Estimation status ───────────────────────────────────────────────

export const RadarEstimationStatusSchema = z.enum([
  'not_estimable',
  'contractual_scenario',
  'award_proxy_scenario',
]);

export type RadarEstimationStatus = z.infer<typeof RadarEstimationStatusSchema>;

// ─── Basis ───────────────────────────────────────────────────────────

export const RadarBasisSchema = z.enum([
  'explicit_start',
  'explicit_award_proxy',
]);

export type RadarBasis = z.infer<typeof RadarBasisSchema>;

// ─── Duration unit ───────────────────────────────────────────────────

export const RadarDurationUnitSchema = z.enum(['DAY', 'MON', 'ANN']);

export type RadarDurationUnit = z.infer<typeof RadarDurationUnitSchema>;

// ─── Evidence ────────────────────────────────────────────────────────

export const RadarEvidenceSchema = z.object({
  campo_fuente: z.string().min(1),
  url: z.string().url().optional(),
  observed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type RadarEvidence = z.infer<typeof RadarEvidenceSchema>;

// ─── Duration ────────────────────────────────────────────────────────

export const RadarDurationSchema = z.object({
  valor: z.number().positive(),
  unidad: RadarDurationUnitSchema,
});

export type RadarDuration = z.infer<typeof RadarDurationSchema>;

// ─── Estimable opportunity (the exposed record) ─────────────────────

/**
 * The minimal contract for an opportunity that has been previously
 * estimable. Every field is required and traceable.
 */
export const RadarOpportunitySchema = z.object({
  id: z.string().min(1),
  lote: z.string().optional(),
  version: z.string().optional(),
  fuente: RadarSourceSchema,
  expediente: z.string().min(1),
  organismo: z.string().min(1),
  objeto: z.string().min(1),
  cpv: z.string().nullable(),
  importe_licitacion: z.number().nullable(),
  importe_adjudicacion: z.number().nullable(),
  adjudicatario: z.string().nullable(),
  fecha_publicacion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  fecha_adjudicacion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  url: z.string().nullable(),
  duracion: RadarDurationSchema.nullable(),
  estimation_status: RadarEstimationStatusSchema,
  estimated_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  confidence: z.null().describe('Always null — no calibration exists'),
  basis: RadarBasisSchema.nullable(),
  evidencia: RadarEvidenceSchema,
  es_sintetico: z.boolean(),
});

export type RadarOpportunity = z.infer<typeof RadarOpportunitySchema>;

// ─── Query parameters ────────────────────────────────────────────────

export const RadarQuerySchema = z.object({
  fuente: RadarSourceSchema.optional().describe('Filter by source'),
  estimation_status: RadarEstimationStatusSchema.optional().describe('Filter by estimation status'),
  cpv: z.string().optional().describe('Filter by CPV code or prefix'),
  organismo: z.string().optional().describe('Filter by organism (substring match)'),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe('Max results (1-100)'),
  offset: z.coerce.number().int().min(0).default(0).describe('Pagination offset'),
});

export type RadarQuery = z.infer<typeof RadarQuerySchema>;

// ─── Response envelope ───────────────────────────────────────────────

export const RadarResponseSchema = z.object({
  opportunities: z.array(RadarOpportunitySchema),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
  meta: z.object({
    lineage_confirmed: z.boolean(),
    coverage_status: z.enum(['safe_empty', 'partial', 'complete']),
    explanation: z.string().optional(),
  }),
});

export type RadarResponse = z.infer<typeof RadarResponseSchema>;

// ─── Safe-empty response (when lineage unverified) ───────────────────

/**
 * When real data lineage is not confirmed, the endpoint returns this
 * structure instead of an empty list. It explicitly states why no
 * data is returned, preventing any inference or fabrication.
 */
export function safeEmptyResponse(explanation: string): RadarResponse {
  return {
    opportunities: [],
    pagination: { total: 0, limit: 20, offset: 0 },
    meta: {
      lineage_confirmed: false,
      coverage_status: 'safe_empty',
      explanation,
    },
  };
}

// ─── Validation helper ───────────────────────────────────────────────

/**
 * Validate a record against the RadarOpportunity contract.
 * Returns { valid: true, data } or { valid: false, errors }.
 */
export function validateOpportunity(
  data: unknown
): { valid: true; data: RadarOpportunity } | { valid: false; errors: string[] } {
  const result = RadarOpportunitySchema.safeParse(data);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  };
}