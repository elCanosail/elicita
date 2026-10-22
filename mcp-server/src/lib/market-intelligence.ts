import { z } from 'zod';

const percentage = z.number().finite().min(0).max(100);
const nonNegative = z.number().finite().nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const MARKET_INTELLIGENCE_SCHEMA = 'elicita.market-intelligence/v1' as const;
export const TECHNOLOGY_DATASET = 'technology' as const;
export const CONSTRUCTION_DATASET = 'construction' as const;
export const HEALTH_DATASET = 'salud' as const;
export const ENERGY_DATASET = 'energia' as const;
export const LIMPIEZA_DATASET = 'limpieza' as const;
export const DEFENSA_DATASET = 'defensa' as const;
export const TRANSPORTE_DATASET = 'transporte' as const;
export const MARKET_INTELLIGENCE_DATASETS = [TECHNOLOGY_DATASET, CONSTRUCTION_DATASET, HEALTH_DATASET, ENERGY_DATASET, LIMPIEZA_DATASET, DEFENSA_DATASET, TRANSPORTE_DATASET] as const;
export const SNAPSHOT_ID_PATTERN = new RegExp(`^(${MARKET_INTELLIGENCE_DATASETS.join('|')})-\\d{8}-\\d{6}Z$`);

export const RECORD_EXCLUSION_REGISTRY_SCHEMA = 'elicita.record-exclusion-registry/v1';
export const recordExclusionRegistrySchema = z.object({
  schema: z.literal(RECORD_EXCLUSION_REGISTRY_SCHEMA),
  version: z.number().int().min(1),
  dataset: z.enum(MARKET_INTELLIGENCE_DATASETS),
  entries: z.array(
    z
      .object({
        record_id: z.string().min(1),
        reason_code: z.string().min(1),
        reason_label: z.string().min(1),
        declared_amount_eur: nonNegative,
        verified_amount_eur: nonNegative,
        evidence_url: z.string().url(),
        decision_date: isoDate,
        decision_source: z.string().min(1),
      })
      .strict(),
  ),
}).strict();

export type RecordExclusionRegistry = z.infer<typeof recordExclusionRegistrySchema>;

export function parseRecordExclusionRegistry(input: unknown): RecordExclusionRegistry {
  return recordExclusionRegistrySchema.parse(input);
}

export const marketSnapshotSchema = z.object({
  schema: z.literal(MARKET_INTELLIGENCE_SCHEMA),
  snapshot_id: z.string().regex(SNAPSHOT_ID_PATTERN),
  dataset: z.enum(MARKET_INTELLIGENCE_DATASETS),
  title: z.string().min(1),
  generated_at: z.string().datetime({ offset: true }),
  period: z.object({ from: isoDate, to: isoDate }),
  source: z.object({
    name: z.string().min(1),
    freshness_date: isoDate,
    fingerprint: sha256,
  }),
  methodology: z.object({
    schema_version: z.literal('1'),
    methodology_version: z.string().min(1),
    taxonomy_version: z.string().min(1),
    identity_registry_version: z.string().min(1),
  }),
  universe: z.object({
    source_rows: z.number().int().nonnegative(),
    sector_candidates: z.number().int().nonnegative(),
    analytic_contracts: z.number().int().nonnegative(),
    excluded_rows: z.number().int().nonnegative(),
  }),
  coverage: z.object({
    cpv_resolved_pct: percentage,
    amount_valid_pct: percentage,
    supplier_nif_valid_pct: percentage,
    supplier_resolved_pct: percentage,
    business_group_resolved_pct: percentage,
    buyer_resolved_pct: percentage,
    ute_unresolved_amount_pct: percentage,
  }),
  metrics: z.object({
    observed_amount_eur: nonNegative,
    companies: z.number().int().nonnegative(),
    business_groups: z.number().int().nonnegative(),
    buyers: z.number().int().nonnegative(),
    hhi_amount: nonNegative.max(10_000),
    hhi_contracts: nonNegative.max(10_000),
  }),
  downloads: z.record(z.string(), z.string().min(1)),
  limitations: z.array(z.string().min(1)),
  license: z.object({
    name: z.string().min(1),
    url: z.string().url(),
  }),
  receipt: z.literal('generation-receipt.json'),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.period.from > snapshot.period.to) {
    ctx.addIssue({ code: 'custom', path: ['period'], message: 'period.from must not be after period.to' });
  }
  if (snapshot.source.freshness_date > snapshot.period.to) {
    ctx.addIssue({ code: 'custom', path: ['source', 'freshness_date'], message: 'freshness must not exceed period.to' });
  }
  if (snapshot.universe.analytic_contracts + snapshot.universe.excluded_rows !== snapshot.universe.sector_candidates) {
    ctx.addIssue({ code: 'custom', path: ['universe'], message: 'analytic contracts and exclusions must reconcile with candidates' });
  }
});

export const GENERATION_RECEIPT_SCHEMA = 'elicita.generation-receipt/v1' as const;

export const generationReceiptSchema = z.object({
  schema: z.literal(GENERATION_RECEIPT_SCHEMA),
  snapshot_id: z.string().regex(SNAPSHOT_ID_PATTERN),
  generated_at: z.string().datetime({ offset: true }),
  pipeline_commit: z.string().regex(/^[a-f0-9]{40}$/),
  working_tree_clean: z.literal(true),
  source_fingerprint: sha256,
  taxonomy_hash: sha256,
  identity_registry_hash: sha256,
  query_hash: sha256,
  outputs: z.record(z.string().min(1), sha256),
  checks: z.object({
    schema_valid: z.literal(true),
    duplicate_analytic_ids: z.literal(0),
    shares_within_tolerance: z.literal(true),
    rankings_deterministic: z.literal(true),
    no_direct_identifiers: z.literal(true),
    minimum_group_policy_applied: z.literal(true),
    freshness_non_regression: z.literal(true),
  }).strict(),
}).strict().superRefine((receipt, ctx) => {
  if (Object.keys(receipt.outputs).length === 0) {
    ctx.addIssue({ code: 'custom', path: ['outputs'], message: 'at least one output hash is required' });
  }
});

export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;
export type GenerationReceipt = z.infer<typeof generationReceiptSchema>;

export function parseMarketSnapshot(input: unknown): MarketSnapshot {
  return marketSnapshotSchema.parse(input);
}

export function parseGenerationReceipt(input: unknown): GenerationReceipt {
  return generationReceiptSchema.parse(input);
}
