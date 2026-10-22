import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const MARKET_INTELLIGENCE_SCHEMA = 'elicita.market-intelligence/v1' as const;
export const GENERATION_RECEIPT_SCHEMA = 'elicita.generation-receipt/v1' as const;
export const TECHNOLOGY_DATASET = 'technology' as const;
export const CONSTRUCTION_DATASET = 'construction' as const;
export const HEALTH_DATASET = 'salud' as const;
export const ENERGY_DATASET = 'energia' as const;
export const LIMPIEZA_DATASET = 'limpieza' as const;
export const DEFENSA_DATASET = 'defensa' as const;
export const TRANSPORTE_DATASET = 'transporte' as const;
export const MARKET_INTELLIGENCE_DATASETS = [TECHNOLOGY_DATASET, CONSTRUCTION_DATASET, HEALTH_DATASET, ENERGY_DATASET, LIMPIEZA_DATASET, DEFENSA_DATASET, TRANSPORTE_DATASET] as const;
export type MarketIntelligenceDataset = (typeof MARKET_INTELLIGENCE_DATASETS)[number];
export const SNAPSHOT_ID_PATTERN = new RegExp(`^(${MARKET_INTELLIGENCE_DATASETS.join('|')})-\\d{8}-\\d{6}Z$`);

export function marketIntelligenceLatestPath(dataset: MarketIntelligenceDataset): string {
  return `/data/market-intelligence/${dataset}/latest/`;
}

const percentage = z.number().finite().min(0).max(100);
const nonNegative = z.number().finite().nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);

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
    ctx.addIssue({ code: 'custom', path: ['period'], message: 'El periodo no está ordenado.' });
  }
  if (snapshot.source.freshness_date > snapshot.period.to) {
    ctx.addIssue({ code: 'custom', path: ['source', 'freshness_date'], message: 'La frescura excede el periodo.' });
  }
  if (snapshot.universe.analytic_contracts + snapshot.universe.excluded_rows !== snapshot.universe.sector_candidates) {
    ctx.addIssue({ code: 'custom', path: ['universe'], message: 'El universo no reconcilia candidatos, contratos y exclusiones.' });
  }
});

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
}).strict();

export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;
export type GenerationReceipt = z.infer<typeof generationReceiptSchema>;

export const downloadArtifacts = [
  { filename: 'snapshot.json', label: 'Snapshot JSON', description: 'Contrato semántico del snapshot.' },
  { filename: 'companies.csv', label: 'Sociedades CSV', description: 'Ranking agregado de adjudicatarios.' },
  { filename: 'business-groups.csv', label: 'Grupos empresariales CSV', description: 'Vista curada de grupos.' },
  { filename: 'buyers.csv', label: 'Compradores CSV', description: 'Ranking de órganos compradores.' },
  { filename: 'concentration.csv', label: 'Concentración CSV', description: 'HHI y cuotas agregadas.' },
  { filename: 'evolution.csv', label: 'Evolución CSV', description: 'Series anuales agregadas.' },
  { filename: 'coverage.csv', label: 'Cobertura CSV', description: 'Cobertura y categorías desconocidas.' },
  { filename: 'exclusions.csv', label: 'Exclusiones CSV', description: 'Exclusiones agregadas.' },
  { filename: 'edges.csv', label: 'Relaciones CSV', description: 'Pares comprador–adjudicataria para el grafo sectorial.' },
  { filename: 'methodology.json', label: 'Metodología JSON', description: 'Taxonomía y reglas versionadas.' },
  { filename: 'generation-receipt.json', label: 'Recibo de generación', description: 'Evidencia de la ejecución reproducible.' },
  { filename: 'checksums.sha256', label: 'Checksums SHA-256', description: 'Verificación de integridad de los artefactos.' },
] as const;

const requiredHashedArtifacts = downloadArtifacts
  .map(({ filename }) => filename)
  .filter((filename) => filename !== 'generation-receipt.json' && filename !== 'checksums.sha256');
const requiredManifestArtifacts = [...requiredHashedArtifacts, 'generation-receipt.json'];

export type PublishedMarketSnapshot = {
  snapshot: MarketSnapshot;
  receipt: GenerationReceipt;
};

export type SnapshotLoadResult =
  | { status: 'published'; value: PublishedMarketSnapshot }
  | { status: 'unavailable'; reason: string };

type FileReader = (filename: string) => Promise<string>;

function sha256For(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function parseChecksums(content: string): Map<string, string> {
  const checksums = new Map<string, string>();

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?([^\s]+)$/);
    if (!match) throw new Error('El archivo de checksums no tiene un formato SHA-256 válido.');
    if (checksums.has(match[2])) throw new Error(`Checksum duplicado para ${match[2]}.`);
    checksums.set(match[2], `sha256:${match[1]}`);
  }

  return checksums;
}

function parseJson(content: string, filename: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${filename} no contiene JSON válido.`);
  }
}

export async function validatePublishedMarketSnapshot(read: FileReader): Promise<PublishedMarketSnapshot> {
  const snapshotContent = await read('snapshot.json');
  const receiptContent = await read('generation-receipt.json');
  const checksums = parseChecksums(await read('checksums.sha256'));

  const expectedManifest = [...requiredManifestArtifacts].sort();
  const actualManifest = [...checksums.keys()].sort();
  if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest)) {
    throw new Error('El manifiesto no cubre exactamente los artefactos publicados.');
  }
  if (checksums.get('generation-receipt.json') !== sha256For(receiptContent)) {
    throw new Error('No se pudo verificar la integridad de generation-receipt.json.');
  }

  const snapshot = marketSnapshotSchema.parse(parseJson(snapshotContent, 'snapshot.json'));
  const receipt = generationReceiptSchema.parse(parseJson(receiptContent, 'generation-receipt.json'));

  if (snapshot.snapshot_id !== receipt.snapshot_id) {
    throw new Error('El recibo de generación no corresponde al snapshot.');
  }
  if (snapshot.source.fingerprint !== receipt.source_fingerprint) {
    throw new Error('La fuente del snapshot no coincide con el recibo de generación.');
  }

  for (const filename of requiredHashedArtifacts) {
    const content = filename === 'snapshot.json' ? snapshotContent : await read(filename);
    const expectedHash = receipt.outputs[filename];
    const checksumHash = checksums.get(filename);
    const actualHash = sha256For(content);

    if (!expectedHash || expectedHash !== actualHash || checksumHash !== actualHash) {
      throw new Error(`No se pudo verificar la integridad de ${filename}.`);
    }
  }

  return { snapshot, receipt };
}

function latestSnapshotDirectory(dataset: MarketIntelligenceDataset): string {
  return resolve(process.cwd(), `public/data/market-intelligence/${dataset}/latest`);
}

export function latestSnapshotFileReader(dataset: MarketIntelligenceDataset): FileReader {
  const directory = latestSnapshotDirectory(dataset);
  return (filename: string) => readFile(join(directory, filename), 'utf8');
}

export async function loadPublishedMarketSnapshot(
  read: FileReader = latestSnapshotFileReader(TECHNOLOGY_DATASET),
): Promise<SnapshotLoadResult> {
  try {
    return { status: 'published', value: await validatePublishedMarketSnapshot(read) };
  } catch (error) {
    console.error(
      '[market-intelligence] snapshot no publicable:',
      error instanceof Error ? error.message : error,
    );
    return {
      status: 'unavailable',
      reason: 'No hay un snapshot validado y verificable para publicar todavía.',
    };
  }
}

/**
 * Lee un artefacto del snapshot publicado. Úsalo tras `loadPublishedMarketSnapshot`:
 * la integridad de estos ficheros ya quedó verificada por checksums en ese paso.
 */
export async function readPublishedArtifact(
  filename: string,
  dataset: MarketIntelligenceDataset = TECHNOLOGY_DATASET,
): Promise<string> {
  return readFile(join(latestSnapshotDirectory(dataset), filename), 'utf8');
}
