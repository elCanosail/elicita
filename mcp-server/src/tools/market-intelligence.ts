import { z } from 'zod';

import { MARKET_INTELLIGENCE_DATASETS } from '../lib/market-intelligence.js';
import {
  loadApprovedSnapshot,
  type ApprovedSnapshot,
  type ApprovedSnapshotConfig,
  type ApprovedSnapshotConfigs,
} from '../lib/approved-snapshot.js';
import type { ToolResult } from '../lib/types.js';
import type { ToolRegistry } from '../lib/tool-registry.js';

export const MARKET_INTELLIGENCE_TOOL_NAMES = [
  'market_snapshot',
  'rank_companies',
  'analyze_buyer',
  'trace_metric',
] as const;

const limitSchema = z.number().int().min(1).max(50).default(10)
  .describe('Máximo de filas del ranking (1-50).');

const traceMetricSchema = z.enum([
  'observed_amount_eur',
  'analytic_contracts',
  'hhi_amount',
  'hhi_contracts',
  'cpv_resolved_pct',
  'amount_valid_pct',
  'supplier_nif_valid_pct',
  'supplier_resolved_pct',
  'business_group_resolved_pct',
  'buyer_resolved_pct',
  'ute_unresolved_amount_pct',
]);

type TraceMetric = z.infer<typeof traceMetricSchema>;

/**
 * Explicit registration point for the editorial P2 gate. The stable server
 * deliberately never calls this function; callers must pass the approved
 * snapshot directories after operational review. Tools accept the configured
 * dataset and default to the first configured one (technology first), keeping
 * pre-multi-dataset clients compatible.
 */
export function registerMarketIntelligenceTools(server: ToolRegistry, configs: ApprovedSnapshotConfigs): void {
  const configuredDatasets = MARKET_INTELLIGENCE_DATASETS.filter((dataset) => configs[dataset] !== undefined);
  if (configuredDatasets.length === 0) return;
  const datasetSchema = z.enum(configuredDatasets as [string, ...string[]])
    .default(configuredDatasets[0])
    .describe('Dataset de mercado aprobado a consultar.');
  const requireConfig = (dataset: string): ApprovedSnapshotConfig => {
    const resolved = (configs as Record<string, ApprovedSnapshotConfig | undefined>)[dataset];
    if (!resolved) throw new Error(`dataset no configurado: ${dataset}`);
    return resolved;
  };

  server.registerTool(
    'market_snapshot',
    {
      title: 'Snapshot de mercado aprobado',
      description: 'Devuelve el contrato y la procedencia del snapshot editorial aprobado del dataset solicitado.',
      inputSchema: z.object({ dataset: datasetSchema.optional() }).optional(),
      annotations: { readOnlyHint: true },
    },
    async ({ dataset }: { dataset?: string } = {}): Promise<ToolResult> => marketSnapshot(requireConfig(dataset ?? configuredDatasets[0])),
  );

  server.registerTool(
    'rank_companies',
    {
      title: 'Ranking de sociedades o grupos',
      description: 'Lee un ranking agregado del snapshot aprobado del dataset solicitado; no ejecuta SQL ni consulta datos vivos.',
      inputSchema: z.object({
        dataset: datasetSchema,
        entity_type: z.enum(['company', 'business_group']).default('company'),
        limit: limitSchema,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ dataset, entity_type, limit }: { dataset?: string; entity_type: 'company' | 'business_group'; limit: number }): Promise<ToolResult> =>
      rankCompanies(requireConfig(dataset ?? configuredDatasets[0]), { entity_type, limit }),
  );

  server.registerTool(
    'analyze_buyer',
    {
      title: 'Analizar comprador',
      description: 'Busca por identificador canónico dentro del snapshot aprobado del dataset solicitado; no hace coincidencias por nombre.',
      inputSchema: z.object({ dataset: datasetSchema, buyer_id: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: true },
    },
    async ({ dataset, buyer_id }: { dataset?: string; buyer_id: string }): Promise<ToolResult> =>
      analyzeBuyer(requireConfig(dataset ?? configuredDatasets[0]), { buyer_id }),
  );

  server.registerTool(
    'trace_metric',
    {
      title: 'Trazar métrica de mercado',
      description: 'Explica el valor, denominador, cobertura y artefactos de una métrica del snapshot aprobado del dataset solicitado.',
      inputSchema: z.object({ dataset: datasetSchema, metric: traceMetricSchema }),
      annotations: { readOnlyHint: true },
    },
    async ({ dataset, metric }: { dataset?: string; metric: TraceMetric }): Promise<ToolResult> =>
      traceMetric(requireConfig(dataset ?? configuredDatasets[0]), { metric }),
  );
}

export function marketSnapshot(config: ApprovedSnapshotConfig): Promise<ToolResult> {
  return runTool(config, snapshot => ({ snapshot: snapshot.snapshot, provenance: provenance(snapshot) }));
}

export function rankCompanies(
  config: ApprovedSnapshotConfig,
  input: { entity_type?: 'company' | 'business_group'; limit?: number },
): Promise<ToolResult> {
  const entityType = input.entity_type ?? 'company';
  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return invalidInput('limit debe estar entre 1 y 50');
  return runTool(config, snapshot => {
    const table = snapshot.tables[entityType === 'company' ? 'companies.csv' : 'business-groups.csv'];
    return {
      entity_type: entityType,
      rows: table.rows.slice(0, limit).map(entityType === 'company' ? companyRow : groupRow),
      provenance: provenance(snapshot),
    };
  });
}

export function analyzeBuyer(config: ApprovedSnapshotConfig, input: { buyer_id: string }): Promise<ToolResult> {
  if (!input.buyer_id) return invalidInput('buyer_id es obligatorio');
  return runTool(config, snapshot => {
    const row = snapshot.tables['buyers.csv'].rows.find(candidate => candidate.buyer_id === input.buyer_id);
    if (!row) throw new MarketToolNotFoundError(`buyer_id no encontrado en el snapshot aprobado: ${input.buyer_id}`);
    return { buyer: buyerRow(row), provenance: provenance(snapshot) };
  });
}

export function traceMetric(config: ApprovedSnapshotConfig, input: { metric: TraceMetric }): Promise<ToolResult> {
  return runTool(config, snapshot => ({ trace: traceMetricValue(snapshot, input.metric), provenance: provenance(snapshot) }));
}

async function runTool(config: ApprovedSnapshotConfig, select: (snapshot: ApprovedSnapshot) => Record<string, unknown>): Promise<ToolResult> {
  try {
    const result = select(await loadApprovedSnapshot(config));
    return {
      content: [
        { type: 'text', text: formatResult(result) },
        { type: 'text', text: JSON.stringify(result) },
      ],
      structuredContent: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'snapshot no disponible';
    return { content: [{ type: 'text', text: `No se puede responder con el snapshot aprobado: ${message}` }], isError: true };
  }
}

function provenance(snapshot: ApprovedSnapshot): Record<string, unknown> {
  const coverageRows = snapshot.tables['coverage.csv'].rows;
  const coverage = Object.fromEntries(coverageRows.map(row => [row.metric, {
    numerator: numberValue(row, 'numerator'),
    denominator: numberValue(row, 'denominator'),
    coverage_pct: numberValue(row, 'coverage_pct'),
    unknown_count: numberValue(row, 'unknown_count'),
    definition: row.definition,
  }]));

  return {
    period: snapshot.snapshot.period,
    denominators: {
      observed_amount_eur: {
        value: snapshot.snapshot.metrics.observed_amount_eur,
        definition: 'Importe observado válido del universo publicado; no equivale a gasto ejecutado.',
      },
      analytic_contracts: {
        value: snapshot.snapshot.universe.analytic_contracts,
        definition: 'Contratos analíticos deduplicados aceptados por la metodología.',
      },
    },
    coverage,
    snapshot: {
      id: snapshot.snapshot.snapshot_id,
      generated_at: snapshot.snapshot.generated_at,
      methodology: snapshot.snapshot.methodology,
      receipt: snapshot.snapshot.receipt,
    },
    source: snapshot.snapshot.source,
    limitations: snapshot.snapshot.limitations,
  };
}

function companyRow(row: Record<string, string>): Record<string, unknown> {
  return {
    rank: integerValue(row, 'rank'), nif: row.nif, company_name: row.company_name,
    analytic_contracts: integerValue(row, 'analytic_contracts'), observed_amount_eur: numberValue(row, 'observed_amount_eur'),
    share_amount_pct: numberValue(row, 'share_amount_pct'), share_contracts_pct: numberValue(row, 'share_contracts_pct'),
    group_id: row.group_id || null, group_name: row.group_name || null,
  };
}

function groupRow(row: Record<string, string>): Record<string, unknown> {
  return {
    rank: integerValue(row, 'rank'), group_id: row.group_id, group_name: row.group_name,
    company_count: integerValue(row, 'company_count'), analytic_contracts: integerValue(row, 'analytic_contracts'),
    observed_amount_eur: numberValue(row, 'observed_amount_eur'), share_amount_pct: numberValue(row, 'share_amount_pct'),
    share_contracts_pct: numberValue(row, 'share_contracts_pct'),
  };
}

function buyerRow(row: Record<string, string>): Record<string, unknown> {
  return {
    rank: integerValue(row, 'rank'), buyer_id: row.buyer_id, buyer_name: row.buyer_name,
    analytic_contracts: integerValue(row, 'analytic_contracts'), observed_amount_eur: numberValue(row, 'observed_amount_eur'),
    share_market_amount_pct: numberValue(row, 'share_market_amount_pct'),
  };
}

function traceMetricValue(snapshot: ApprovedSnapshot, metric: TraceMetric): Record<string, unknown> {
  if (metric in snapshot.snapshot.coverage) {
    const row = snapshot.tables['coverage.csv'].rows.find(candidate => candidate.metric === metric);
    if (!row) throw new Error(`coverage.csv no contiene ${metric}`);
    return {
      metric,
      value: numberValue(row, 'coverage_pct'),
      unit: 'pct',
      numerator: numberValue(row, 'numerator'),
      denominator: numberValue(row, 'denominator'),
      unknown_count: numberValue(row, 'unknown_count'),
      definition: row.definition,
      artifacts: ['snapshot.json', 'coverage.csv', 'generation-receipt.json', 'checksums.sha256'],
    };
  }

  if (metric === 'observed_amount_eur') {
    return {
      metric, value: snapshot.snapshot.metrics.observed_amount_eur, unit: 'EUR',
      denominator: snapshot.snapshot.metrics.observed_amount_eur,
      definition: 'Importe observado válido del universo publicado; no equivale a gasto ejecutado.',
      artifacts: ['snapshot.json', 'companies.csv', 'buyers.csv', 'generation-receipt.json', 'checksums.sha256'],
    };
  }

  if (metric === 'analytic_contracts') {
    return {
      metric, value: snapshot.snapshot.universe.analytic_contracts, unit: 'contracts',
      denominator: snapshot.snapshot.universe.analytic_contracts,
      definition: 'Contratos analíticos deduplicados aceptados por la metodología.',
      artifacts: ['snapshot.json', 'generation-receipt.json', 'checksums.sha256'],
    };
  }

  const concentrationRows = snapshot.tables['concentration.csv'].rows
    .filter(row => row.dimension === (metric === 'hhi_amount' ? 'companies_amount' : 'companies_contracts'))
    .map(row => ({ period: row.period, hhi: numberValue(row, 'hhi'), valid_denominator: numberValue(row, 'valid_denominator') }));
  const value = metric === 'hhi_amount'
    ? snapshot.snapshot.metrics.hhi_amount
    : snapshot.snapshot.metrics.hhi_contracts;
  return {
    metric,
    value,
    unit: 'hhi',
    denominator: concentrationRows[0]?.valid_denominator
      ?? (metric === 'hhi_amount' ? snapshot.snapshot.metrics.observed_amount_eur : snapshot.snapshot.universe.analytic_contracts),
    definition: 'Índice Herfindahl-Hirschman calculado desde cuotas no redondeadas sobre el denominador válido declarado.',
    concentration_rows: concentrationRows,
    artifacts: ['snapshot.json', 'concentration.csv', 'generation-receipt.json', 'checksums.sha256'],
  };
}

function formatResult(result: Record<string, unknown>): string {
  const provenanceValue = result.provenance;
  const provenanceRecord = provenanceValue && typeof provenanceValue === 'object' ? provenanceValue as Record<string, unknown> : undefined;
  const snapshot = provenanceRecord?.snapshot as Record<string, unknown> | undefined;
  const period = provenanceRecord?.period as Record<string, unknown> | undefined;
  return [
    `Snapshot aprobado: ${snapshot?.id ?? 'no disponible'}`,
    `Periodo: ${period?.from ?? '—'} a ${period?.to ?? '—'}`,
    'Resultado estructurado y trazable adjunto; no consulta datos vivos.',
  ].join('\n');
}

function numberValue(row: Record<string, string>, key: string): number {
  return Number(row[key]);
}

function integerValue(row: Record<string, string>, key: string): number {
  return Number.parseInt(row[key]!, 10);
}

class MarketToolNotFoundError extends Error {}

function invalidInput(message: string): Promise<ToolResult> {
  return Promise.resolve({ content: [{ type: 'text', text: message }], isError: true });
}
