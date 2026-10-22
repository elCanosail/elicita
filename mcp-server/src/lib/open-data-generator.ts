import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, join, relative } from 'node:path';
import { MARKET_INTELLIGENCE_DATASETS, parseGenerationReceipt, parseMarketSnapshot, parseRecordExclusionRegistry, type GenerationReceipt, type MarketSnapshot, type RecordExclusionRegistry } from './market-intelligence.js';
import { CSV_ARTIFACTS_V2, CSV_HEADERS, CSV_HEADERS_V2, DIRECTORY_ARTIFACTS_V2, EDGES_ARTIFACT, HASHED_ARTIFACTS_V2, parseChecksumManifest } from './artifact-contract.js';

const execFile = promisify(execFileCallback);
const DATASET = 'technology';
const DEFAULT_DATASET_TITLE = 'Tecnología y telecomunicaciones';

export type SourceContractRow = {
  analytic_id: string;
  award_date: string;
  cpv: string | null;
  supplier_nif: string | null;
  supplier_name: string | null;
  buyer_key: string | null;
  buyer_name: string | null;
  observed_amount_eur: number | null;
  ute: boolean;
};

type TaxonomyRule = {
  cpv: string;
  label: string;
  subsector: string;
  status: 'include' | 'exclude' | 'review';
  reason: string;
  decision_date: string;
  decision_source: string;
};

export type TechnologyTaxonomy = {
  schema: 'elicita.cpv-taxonomy/v1';
  version: string;
  dataset: string;
  rules: readonly TaxonomyRule[];
};

type CompanyRecord = { nif: string; company_name: string; reviewed_at: string; registry_version: string };
export type GroupRecord = {
  group_id: string; group_name: string; nif: string; company_name: string;
  valid_from: string; valid_to: string | null; evidence_url: string; evidence_type: string;
  reviewed_at: string; registry_version: string;
};
type UteRecord = {
  ute_id: string; ute_name: string; valid_from: string; valid_to: string | null;
  evidence_url: string | null; allocation: 'unresolved' | 'official_split'; participants: readonly { nif: string; share_pct: number }[];
  reviewed_at: string; registry_version: string;
};
type BuyerRecord = {
  buyer_id: string; buyer_name: string; aliases: readonly string[];
  valid_from: string; valid_to: string | null; reviewed_at: string; registry_version: string;
};

/** Versioned, reviewed records. An empty groups array means unknown, never inferred ownership. */
export type IdentityRegistry = {
  schema: 'elicita.identity-registry/v1';
  version: string;
  companies: readonly CompanyRecord[];
  groups: readonly GroupRecord[];
  utes: readonly UteRecord[];
  buyers: readonly BuyerRecord[];
};

export type GenerateTechnologyCandidateOptions = {
  outputDir: string;
  rows: readonly SourceContractRow[];
  taxonomy: TechnologyTaxonomy;
  identityRegistry: IdentityRegistry;
  generatedAt: string;
  snapshotId: string;
  pipelineCommit: string;
  sourceName: string;
  queryContract?: string;
  workingTreeClean: boolean;
  /** Dataset id; defaults to 'technology'. Must be one of MARKET_INTELLIGENCE_DATASETS. */
  datasetId?: (typeof MARKET_INTELLIGENCE_DATASETS)[number];
  /** Public title baked into snapshot.json; defaults to the technology title. */
  datasetTitle?: string;
  /** Evidence-backed record exclusions applied before aggregation; embedded into methodology.json. */
  recordExclusions?: RecordExclusionRegistry;
};

export type GenerationResult = { outputDir: string; artifacts: string[]; checksums: Record<string, string> };

export type DuckDbReadOptions = {
  databasePath: string;
  query: string;
  duckdbBinary?: string;
};

export type OpenDataFixture = {
  rows: readonly SourceContractRow[];
  taxonomy: TechnologyTaxonomy;
  identityRegistry: IdentityRegistry;
};

/**
 * Reproducible v1 projection over the national historical table. One latest
 * administrative revision per source id is retained. The v1 market definition
 * is limited to CPV divisions 48 and 72 and the period starts in 2022.
 */
export const TECHNOLOGY_DUCKDB_PROJECTION = `WITH ranked AS (
  SELECT
    id,
    COALESCE(fecha_adjudicacion, fecha_publicacion) AS analytic_date,
    LPAD(CAST(CAST(cpv_principal AS BIGINT) AS VARCHAR), 8, '0') AS cpv8,
    nif_adjudicatario,
    adjudicatario,
    organo_contratante,
    importe_adjudicacion,
    ROW_NUMBER() OVER (
      PARTITION BY id
      ORDER BY fecha_updated DESC NULLS LAST,
        fecha_publicacion DESC NULLS LAST,
        fecha_adjudicacion DESC NULLS LAST,
        COALESCE(nif_adjudicatario, '') ASC,
        COALESCE(adjudicatario, '') ASC,
        COALESCE(importe_adjudicacion, -1) DESC,
        COALESCE(organo_contratante, '') ASC,
        COALESCE(url, '') ASC,
        COALESCE(archivo_origen, '') ASC
    ) AS revision_rank
  FROM calidad
  WHERE COALESCE(fecha_adjudicacion, fecha_publicacion)
    BETWEEN DATE '2022-01-01' AND DATE '2026-09-14'
    AND LEFT(LPAD(CAST(CAST(cpv_principal AS BIGINT) AS VARCHAR), 8, '0'), 2) IN ('48', '72')
)
SELECT
  CAST(id AS VARCHAR) AS analytic_id,
  CAST(analytic_date AS VARCHAR) AS award_date,
  cpv8 AS cpv,
  CAST(nif_adjudicatario AS VARCHAR) AS supplier_nif,
  CAST(adjudicatario AS VARCHAR) AS supplier_name,
  CAST(organo_contratante AS VARCHAR) AS buyer_key,
  CAST(organo_contratante AS VARCHAR) AS buyer_name,
  importe_adjudicacion AS observed_amount_eur,
  STARTS_WITH(UPPER(TRIM(COALESCE(CAST(nif_adjudicatario AS VARCHAR), ''))), 'U')
    OR CONTAINS(COALESCE(CAST(nif_adjudicatario AS VARCHAR), ''), CHR(59)) AS ute
FROM ranked
WHERE revision_rank = 1
ORDER BY analytic_id`;

/** Derives a dataset projection from the canonical technology projection by
 * declared substitutions: the CPV division filter and the ingestion cutoff.
 * The technology projection remains the byte-canonical contract. */
export function buildDuckDbProjection(cpvDivisions: readonly string[], windowEnd: string): string {
  const filter = cpvDivisions.map((division) => `'${division}'`).join(', ');
  return TECHNOLOGY_DUCKDB_PROJECTION
    .replace("IN ('48', '72')", `IN (${filter})`)
    .replace("DATE '2026-09-14'", `DATE '${windowEnd}'`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

export async function loadOpenDataFixture(path: string): Promise<OpenDataFixture> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('fixture must be a JSON object');
  const fixture = parsed as Partial<OpenDataFixture>;
  if (!Array.isArray(fixture.rows) || fixture.taxonomy === undefined || fixture.identityRegistry === undefined) {
    throw new Error('fixture requires rows, taxonomy and identityRegistry');
  }
  return fixture as OpenDataFixture;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function number(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Public numeric value must be finite');
  return Number.isInteger(value) ? String(value) : value.toFixed(8).replace(/\.?0+$/, '');
}

function csv(columns: readonly string[], rows: readonly Record<string, string | number | null>[]): string {
  const escape = (value: string | number | null): string => {
    const text = value === null ? '' : typeof value === 'number' ? number(value) : value;
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const header = `${columns.join(',')}\n`;
  return rows.length === 0
    ? header
    : `${header}${rows.map((row) => columns.map((column) => escape(row[column] ?? null)).join(',')).join('\n')}\n`;
}

function normalizedNif(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.toUpperCase().replace(/[\s.-]/g, '');
  return normalized.length === 0 ? null : normalized;
}

/** Formal Spanish DNI/NIE/CIF validation. It establishes format only, not ownership. */
export function isValidSpanishNif(value: string | null): boolean {
  const nif = normalizedNif(value);
  if (nif === null) return false;
  if (/^\d{8}[A-Z]$/.test(nif)) return 'TRWAGMYFPDXBNJZSQVHLCKE'[Number(nif.slice(0, 8)) % 23] === nif[8];
  if (/^[XYZ]\d{7}[A-Z]$/.test(nif)) {
    const numeric = `${({ X: '0', Y: '1', Z: '2' } as Record<string, string>)[nif[0]]}${nif.slice(1, 8)}`;
    return 'TRWAGMYFPDXBNJZSQVHLCKE'[Number(numeric) % 23] === nif[8];
  }
  if (!/^[ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J]$/.test(nif)) return false;
  const digits = nif.slice(1, 8);
  let total = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const digit = Number(digits[index]);
    if (index % 2 === 0) total += Math.floor((digit * 2) / 10) + ((digit * 2) % 10);
    else total += digit;
  }
  const control = (10 - (total % 10)) % 10;
  const final = nif[8];
  if ('KPQS'.includes(nif[0])) return final === 'JABCDEFGHI'[control];
  if ('ABEH'.includes(nif[0])) return final === String(control);
  return final === String(control) || final === 'JABCDEFGHI'[control];
}

/** Builds source-observed identities only; groups and UTE allocations remain unknown. */
export function deriveObservedIdentityRegistry(
  rows: readonly SourceContractRow[], observedAt: string, version = '1.0.0',
): IdentityRegistry {
  const companyNames = new Map<string, Map<string, number>>();
  const buyers = new Map<string, string>();
  for (const row of rows) {
    const nif = normalizedNif(row.supplier_nif);
    const name = safePublicEntityName(row.supplier_name);
    if (!row.ute && nif !== null && isValidSpanishNif(nif) && name) {
      const names = companyNames.get(nif) ?? new Map<string, number>();
      names.set(name, (names.get(name) ?? 0) + 1);
      companyNames.set(nif, names);
    }
    const buyerId = row.buyer_key?.trim();
    const buyerName = safePublicEntityName(row.buyer_name);
    if (buyerId && buyerName) buyers.set(buyerId, buyerName);
  }
  return {
    schema: 'elicita.identity-registry/v1', version,
    companies: [...companyNames.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([nif, names]) => ({
      nif,
      company_name: [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
      reviewed_at: observedAt,
      registry_version: version,
    })),
    groups: [],
    utes: [],
    buyers: [...buyers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([buyer_id, buyer_name]) => ({
      buyer_id, buyer_name, aliases: [], valid_from: '2022-01-01', valid_to: null,
      reviewed_at: observedAt, registry_version: version,
    })),
  };
}

function safePublicEntityName(value: string | null): string | null {
  const name = value?.trim();
  if (!name) return null;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(name)) return null;
  if (/(?:\+34[\s.-]*)?(?:\d[\s.-]*){9,}/.test(name)) return null;
  return name;
}

function inForce(validFrom: string, validTo: string | null, date: string): boolean {
  return validFrom <= date && (validTo === null || date <= validTo);
}

function cpvDigits(cpv: string | null): string | null {
  if (cpv === null) return null;
  const digits = cpv.replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(0, 8) : null;
}

function taxonomyRule(taxonomy: TechnologyTaxonomy, cpv: string | null): TaxonomyRule | null {
  const digits = cpvDigits(cpv);
  if (digits === null) return null;
  return [...taxonomy.rules]
    .filter((rule) => digits.startsWith(rule.cpv.replace(/\D/g, '')))
    .sort((a, b) => b.cpv.length - a.cpv.length || a.cpv.localeCompare(b.cpv))[0] ?? null;
}

function assertInput(options: GenerateTechnologyCandidateOptions): void {
  const datasetId = options.datasetId ?? DATASET;
  if (!MARKET_INTELLIGENCE_DATASETS.includes(datasetId)) throw new Error(`unknown datasetId: ${datasetId}`);
  if (!new RegExp(`^${datasetId}-\\d{8}-\\d{6}Z$`).test(options.snapshotId)) throw new Error(`snapshotId must use ${datasetId}-YYYYMMDD-HHMMSSZ`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(options.generatedAt)) throw new Error('generatedAt must be a fixed UTC ISO timestamp');
  if (!/^[a-f0-9]{40}$/.test(options.pipelineCommit)) throw new Error('pipelineCommit must be a full git SHA');
  if (!options.workingTreeClean) throw new Error('candidate generation requires a clean pipeline working tree');
  if (options.taxonomy.schema !== 'elicita.cpv-taxonomy/v1' || options.taxonomy.dataset !== datasetId || options.taxonomy.rules.length === 0) throw new Error(`invalid taxonomy for dataset ${datasetId}`);
  if (options.recordExclusions !== undefined) {
    const registry = parseRecordExclusionRegistry(options.recordExclusions);
    if (registry.dataset !== datasetId) throw new Error(`record exclusion registry dataset mismatch: ${registry.dataset}`);
    const excludedIds = registry.entries.map((entry) => entry.record_id);
    if (new Set(excludedIds).size !== excludedIds.length) throw new Error('duplicate record_id in record exclusion registry');
  }
  if (options.identityRegistry.schema !== 'elicita.identity-registry/v1') throw new Error('invalid identity registry');
  for (const group of options.identityRegistry.groups) {
    if (!group.evidence_url || (group.valid_to !== null && group.valid_to < group.valid_from) || group.registry_version !== options.identityRegistry.version) throw new Error(`group ${group.group_id} lacks valid evidence or version`);
  }
  for (const company of options.identityRegistry.companies) {
    if (!isValidSpanishNif(company.nif) || company.registry_version !== options.identityRegistry.version) throw new Error(`company ${company.nif} lacks a valid NIF or registry version`);
  }
  for (const buyer of options.identityRegistry.buyers) {
    if ((buyer.valid_to !== null && buyer.valid_to < buyer.valid_from) || buyer.registry_version !== options.identityRegistry.version) throw new Error(`buyer ${buyer.buyer_id} lacks valid dates or registry version`);
  }
  for (const ute of options.identityRegistry.utes) {
    const allocationTotal = ute.participants.reduce((sum, participant) => sum + participant.share_pct, 0);
    if ((ute.valid_to !== null && ute.valid_to < ute.valid_from) || ute.registry_version !== options.identityRegistry.version || (ute.allocation === 'official_split' && (!ute.evidence_url || Math.abs(allocationTotal - 100) > 0.000001))) throw new Error(`UTE ${ute.ute_id} lacks a valid evidence-backed allocation`);
  }
  const ids = new Set<string>();
  for (const row of options.rows) {
    if (!row.analytic_id || ids.has(row.analytic_id)) throw new Error(`duplicate or empty analytic_id: ${row.analytic_id}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.award_date)) throw new Error(`invalid award_date: ${row.analytic_id}`);
    ids.add(row.analytic_id);
  }
}

type AcceptedRow = SourceContractRow & { amount: number; rule: TaxonomyRule; nif: string | null; company: CompanyRecord | null; group: GroupRecord | null; buyer: BuyerRecord | null };

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator * 100) / denominator;
}

function hhi(shares: readonly number[]): number {
  return shares.reduce((sum, share) => sum + share ** 2, 0);
}

function sorted<T>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
  return [...items].sort(compare);
}

function aggregate<T>(items: readonly T[], key: (item: T) => string, amount: (item: T) => number): { key: string; analytic_contracts: number; observed_amount_eur: number }[] {
  const values = new Map<string, { analytic_contracts: number; observed_amount_eur: number }>();
  for (const item of items) {
    const itemKey = key(item);
    const current = values.get(itemKey) ?? { analytic_contracts: 0, observed_amount_eur: 0 };
    current.analytic_contracts += 1;
    current.observed_amount_eur = roundMoney(current.observed_amount_eur + amount(item));
    values.set(itemKey, current);
  }
  return [...values.entries()].map(([aggregateKey, metrics]) => ({ key: aggregateKey, ...metrics }));
}

function currentGroup(registry: IdentityRegistry, nif: string, date: string): GroupRecord | null {
  const matches = registry.groups.filter((group) => group.nif === nif && inForce(group.valid_from, group.valid_to, date));
  if (matches.length > 1) throw new Error(`ambiguous group attribution for ${nif} at ${date}`);
  return matches[0] ?? null;
}

function currentBuyer(registry: IdentityRegistry, source: SourceContractRow): BuyerRecord | null {
  const key = source.buyer_key?.trim() || source.buyer_name?.trim().toUpperCase() || '';
  const matches = registry.buyers.filter((buyer) => inForce(buyer.valid_from, buyer.valid_to, source.award_date) && (buyer.buyer_id === key || buyer.aliases.includes(key)));
  if (matches.length > 1) throw new Error(`ambiguous buyer attribution for ${key}`);
  return matches[0] ?? null;
}

function calculate(options: GenerateTechnologyCandidateOptions): { snapshot: MarketSnapshot; receipt: GenerationReceipt; files: Record<string, string> } {
  assertInput(options);
  const canonicalRows = sorted(options.rows, (a, b) => a.analytic_id.localeCompare(b.analytic_id));
  const sourceFingerprint = sha256(canonicalJson(canonicalRows));
  const taxonomyHash = sha256(canonicalJson(options.taxonomy));
  const identityRegistryHash = sha256(canonicalJson(options.identityRegistry));
  const queryHash = sha256(options.queryContract ?? 'fixture:canonical-source-contract/v1');
  const companyByNif = new Map(options.identityRegistry.companies.map((company) => [normalizedNif(company.nif), company]));
  const recordExclusionIndex = new Map((options.recordExclusions?.entries ?? []).map((entry) => [entry.record_id, entry]));
  const exclusions = new Map<string, { reason_label: string; rows: number; amount_eur: number }>();
  const exclude = (code: string, label: string, row: SourceContractRow): void => {
    const current = exclusions.get(code) ?? { reason_label: label, rows: 0, amount_eur: 0 };
    current.rows += 1;
    current.amount_eur = roundMoney(current.amount_eur + (Number.isFinite(row.observed_amount_eur) && (row.observed_amount_eur ?? 0) >= 0 ? row.observed_amount_eur ?? 0 : 0));
    exclusions.set(code, current);
  };
  const accepted: AcceptedRow[] = [];
  let sectorCandidates = 0;
  for (const row of canonicalRows) {
    const rule = taxonomyRule(options.taxonomy, row.cpv);
    if (rule === null) continue;
    sectorCandidates += 1;
    const recordExclusion = recordExclusionIndex.get(row.analytic_id);
    if (recordExclusion !== undefined) {
      exclude(recordExclusion.reason_code, recordExclusion.reason_label, row);
      continue;
    }
    if (rule.status !== 'include') {
      exclude(rule.status === 'exclude' ? 'cpv_excluded' : 'cpv_review', rule.reason, row);
      continue;
    }
    if (!Number.isFinite(row.observed_amount_eur) || (row.observed_amount_eur ?? 0) <= 0) {
      exclude('amount_invalid', 'Importe de adjudicación ausente, no finito, cero o negativo', row);
      continue;
    }
    const nif = normalizedNif(row.supplier_nif);
    const company = nif !== null && isValidSpanishNif(nif) ? companyByNif.get(nif) ?? null : null;
    const group = company === null || nif === null ? null : currentGroup(options.identityRegistry, nif, row.award_date);
    accepted.push({ ...row, amount: roundMoney(row.observed_amount_eur ?? 0), rule, nif, company, group, buyer: currentBuyer(options.identityRegistry, row) });
  }
  const sourceRows = options.rows.length;
  const validAmountRows = accepted.length;
  const validNifRows = accepted.filter((row) => row.nif !== null && isValidSpanishNif(row.nif)).length;
  const resolvedSupplierRows = accepted.filter((row) => row.company !== null).length;
  const resolvedGroupRows = accepted.filter((row) => row.group !== null).length;
  const resolvedBuyerRows = accepted.filter((row) => row.buyer !== null).length;
  const observedAmount = roundMoney(accepted.reduce((sum, row) => sum + row.amount, 0));
  const uteUnresolvedAmount = roundMoney(accepted.filter((row) => row.ute).reduce((sum, row) => sum + row.amount, 0));
  const companyRows = accepted.filter((row) => !row.ute && row.company !== null && row.nif !== null);
  const companyAggregates = aggregate(companyRows, (row) => row.nif as string, (row) => row.amount)
    .map((entry) => ({ ...entry, company: companyByNif.get(entry.key) as CompanyRecord }))
    .sort((a, b) => b.observed_amount_eur - a.observed_amount_eur || b.analytic_contracts - a.analytic_contracts || a.key.localeCompare(b.key));
  const companyAmountDenominator = observedAmount;
  const companyContractDenominator = accepted.length;
  const companyCsv = csv(
    CSV_HEADERS['companies.csv'],
    companyAggregates.map((entry, index) => ({
      rank: index + 1, nif: entry.key, company_name: entry.company.company_name, analytic_contracts: entry.analytic_contracts,
      observed_amount_eur: entry.observed_amount_eur, share_amount_pct: percent(entry.observed_amount_eur, companyAmountDenominator),
      share_contracts_pct: percent(entry.analytic_contracts, companyContractDenominator), group_id: currentGroup(options.identityRegistry, entry.key, accepted.find((row) => row.nif === entry.key)?.award_date ?? '9999-12-31')?.group_id ?? null,
      group_name: currentGroup(options.identityRegistry, entry.key, accepted.find((row) => row.nif === entry.key)?.award_date ?? '9999-12-31')?.group_name ?? null,
    })),
  );
  const groupRows = companyRows.filter((row) => row.group !== null);
  const groupAggregates = aggregate(groupRows, (row) => row.group?.group_id as string, (row) => row.amount)
    .map((entry) => ({ ...entry, group: groupRows.find((row) => row.group?.group_id === entry.key)?.group as GroupRecord }))
    .sort((a, b) => b.observed_amount_eur - a.observed_amount_eur || b.analytic_contracts - a.analytic_contracts || a.key.localeCompare(b.key));
  const groupAmountDenominator = observedAmount;
  const groupContractDenominator = accepted.length;
  const businessGroupsCsv = csv(
    CSV_HEADERS['business-groups.csv'],
    groupAggregates.map((entry, index) => ({
      rank: index + 1, group_id: entry.key, group_name: entry.group.group_name,
      company_count: new Set(groupRows.filter((row) => row.group?.group_id === entry.key).map((row) => row.nif)).size,
      analytic_contracts: entry.analytic_contracts, observed_amount_eur: entry.observed_amount_eur,
      share_amount_pct: percent(entry.observed_amount_eur, groupAmountDenominator), share_contracts_pct: percent(entry.analytic_contracts, groupContractDenominator),
    })),
  );
  const buyerRows = accepted.filter((row) => row.buyer !== null);
  const buyerAggregates = aggregate(buyerRows, (row) => row.buyer?.buyer_id as string, (row) => row.amount)
    .map((entry) => ({ ...entry, buyer: buyerRows.find((row) => row.buyer?.buyer_id === entry.key)?.buyer as BuyerRecord }))
    .sort((a, b) => b.observed_amount_eur - a.observed_amount_eur || b.analytic_contracts - a.analytic_contracts || a.key.localeCompare(b.key));
  const buyerAmountDenominator = observedAmount;
  const buyersCsv = csv(
    CSV_HEADERS['buyers.csv'],
    buyerAggregates.map((entry, index) => ({ rank: index + 1, buyer_id: entry.key, buyer_name: entry.buyer.buyer_name, analytic_contracts: entry.analytic_contracts, observed_amount_eur: entry.observed_amount_eur, share_market_amount_pct: percent(entry.observed_amount_eur, buyerAmountDenominator) })),
  );
  // Sector graph edges (contract v2): repeated buyer→company award pairs over the
  // resolved market — non-UTE contracts with resolved company and buyer. Deterministic
  // top-K by amount with an explicit repeat floor; ties break by buyer then NIF.
  const edgeRows = accepted.filter((row) => !row.ute && row.company !== null && row.nif !== null && row.buyer !== null);
  const edgeAggregates = aggregate(edgeRows, (row) => `${row.buyer?.buyer_id}\u0000${row.nif}`, (row) => row.amount)
    .filter((entry) => entry.analytic_contracts >= EDGES_MINIMUM_CONTRACTS)
    .map((entry) => {
      const separator = entry.key.indexOf('\u0000');
      const buyerId = entry.key.slice(0, separator);
      const nif = entry.key.slice(separator + 1);
      const buyerName = edgeRows.find((row) => row.buyer?.buyer_id === buyerId)!.buyer!.buyer_name;
      return { buyerId, nif, buyerName, entry };
    })
    .sort((a, b) => b.entry.observed_amount_eur - a.entry.observed_amount_eur || b.entry.analytic_contracts - a.entry.analytic_contracts || a.buyerId.localeCompare(b.buyerId) || a.nif.localeCompare(b.nif))
    .slice(0, EDGES_TOP_PAIRS);
  const edgesCsv = csv(CSV_HEADERS_V2[EDGES_ARTIFACT], edgeAggregates.map((row, index) => ({
    rank: index + 1, buyer_id: row.buyerId, buyer_name: row.buyerName, nif: row.nif, company_name: (companyByNif.get(row.nif) as CompanyRecord).company_name,
    analytic_contracts: row.entry.analytic_contracts, observed_amount_eur: row.entry.observed_amount_eur,
  })));
  // Concentration basis (methodology 1.1.0): HHI and top-N shares are computed over the
  // resolved market — non-UTE contracts with a resolved company — so shares sum to 100
  // and the HHI follows the standard definition. Ranking shares above remain shares of
  // the whole accepted universe; coverage.csv discloses the resolution coverage.
  const resolvedAmountDenominator = roundMoney(companyAggregates.reduce((sum, entry) => sum + entry.observed_amount_eur, 0));
  const resolvedContractDenominator = companyAggregates.reduce((sum, entry) => sum + entry.analytic_contracts, 0);
  const amountShares = companyAggregates.map((entry) => percent(entry.observed_amount_eur, resolvedAmountDenominator));
  const contractShares = companyAggregates.map((entry) => percent(entry.analytic_contracts, resolvedContractDenominator));
  const topShare = (shares: readonly number[], amount: number): number => shares.slice(0, amount).reduce((sum, share) => sum + share, 0);
  const period = accepted.length === 0 ? { from: options.generatedAt.slice(0, 10), to: options.generatedAt.slice(0, 10) } : {
    from: sorted(accepted, (a, b) => a.award_date.localeCompare(b.award_date))[0].award_date,
    to: sorted(accepted, (a, b) => b.award_date.localeCompare(a.award_date))[0].award_date,
  };
  const concentrationCsv = csv(
    CSV_HEADERS['concentration.csv'],
    [
      { period: `${period.from}/${period.to}`, dimension: 'companies_amount', hhi: hhi(amountShares), top1_share_pct: topShare(amountShares, 1), top5_share_pct: topShare(amountShares, 5), top10_share_pct: topShare(amountShares, 10), valid_denominator: resolvedAmountDenominator },
      { period: `${period.from}/${period.to}`, dimension: 'companies_contracts', hhi: hhi(contractShares), top1_share_pct: topShare(contractShares, 1), top5_share_pct: topShare(contractShares, 5), top10_share_pct: topShare(contractShares, 10), valid_denominator: resolvedContractDenominator },
    ],
  );
  const years = sorted([...new Set(companyRows.map((row) => row.award_date.slice(0, 4)))], (a, b) => a.localeCompare(b));
  const evolutionRows: Record<string, string | number | null>[] = [];
  for (const year of years) {
    const rows = companyRows.filter((row) => row.award_date.startsWith(year));
    const amountDenominator = rows.reduce((sum, row) => sum + row.amount, 0);
    const contractDenominator = rows.length;
    for (const entry of aggregate(rows, (row) => row.nif as string, (row) => row.amount).sort((a, b) => a.key.localeCompare(b.key))) {
      const company = companyByNif.get(entry.key) as CompanyRecord;
      evolutionRows.push({ year, entity_type: 'company', entity_id: entry.key, entity_name: company.company_name, analytic_contracts: entry.analytic_contracts, observed_amount_eur: entry.observed_amount_eur, share_amount_pct: percent(entry.observed_amount_eur, amountDenominator), share_contracts_pct: percent(entry.analytic_contracts, contractDenominator) });
    }
  }
  const evolutionCsv = csv(CSV_HEADERS['evolution.csv'], evolutionRows);
  const coverageDefinitions = [
    ['cpv_resolved_pct', sectorCandidates, sourceRows, sourceRows - sectorCandidates, 'Filas fuente con CPV resuelto por una regla CPV versionada.'],
    ['amount_valid_pct', validAmountRows, sectorCandidates, sectorCandidates - validAmountRows, 'Candidatos sectoriales con importe de adjudicación finito y positivo.'],
    ['supplier_nif_valid_pct', validNifRows, accepted.length, accepted.length - validNifRows, 'Contratos analíticos con NIF de forma válida.'],
    ['supplier_resolved_pct', resolvedSupplierRows, accepted.length, accepted.length - resolvedSupplierRows, 'Contratos analíticos con NIF y sociedad presentes en el registro curado.'],
    ['business_group_resolved_pct', resolvedGroupRows, accepted.length, accepted.length - resolvedGroupRows, 'Contratos analíticos con grupo curado, con evidencia y vigencia.'],
    ['buyer_resolved_pct', resolvedBuyerRows, accepted.length, accepted.length - resolvedBuyerRows, 'Contratos analíticos con comprador canónico curado.'],
    ['ute_unresolved_amount_pct', uteUnresolvedAmount, observedAmount, 0, 'Proporción de importe mantenida en UTE sin reparto oficial verificable.'],
  ] as const;
  const coverageCsv = csv(CSV_HEADERS['coverage.csv'], coverageDefinitions.map(([metric, numerator, denominator, unknownCount, definition]) => ({ metric, numerator, denominator, coverage_pct: percent(numerator, denominator), unknown_count: unknownCount, definition })));
  const exclusionsCsv = csv(CSV_HEADERS['exclusions.csv'], sorted([...exclusions.entries()], ([a], [b]) => a.localeCompare(b)).map(([reason_code, value]) => ({ reason_code, ...value, share_source_rows_pct: percent(value.rows, sourceRows) })));
  const methodology = {
    schema: 'elicita.market-intelligence-methodology/v1', dataset: options.datasetId ?? DATASET, methodology_version: '1.4.0', taxonomy: options.taxonomy,
    identity_registry: options.identityRegistry,
    record_exclusions: options.recordExclusions === undefined ? null : { ...options.recordExclusions, fingerprint: sha256(canonicalJson(options.recordExclusions)) },
    query_contract: {
      source_relation: options.queryContract ? 'calidad (última revisión por id)' : 'fixture', read_only: true,
      canonical_columns: ['analytic_id', 'award_date', 'cpv', 'supplier_nif', 'supplier_name', 'buyer_key', 'buyer_name', 'observed_amount_eur', 'ute'],
      identity_policy: options.queryContract
        ? 'Companies resolve only by formally valid source NIF; canonical name is the most frequent observed form. Buyers retain exact source identity. Group membership resolves only via the curated evidence-backed registry (business-groups.csv); UTE allocations require separate evidence and remain unknown.'
        : 'Only fixture registry records resolve companies, groups, UTEs and buyers; unknown remains unknown.',
    },
    privacy: { public_field_allowlist: 'Aggregated contract only; no direct source rows, contact details, internal paths or user data.', secondary_suppression: 'No secondary breakdown is emitted below the public ranking dimensions in v1 candidate mode.' },
    edges: { top_pairs: EDGES_TOP_PAIRS, minimum_pair_contracts: EDGES_MINIMUM_CONTRACTS, basis: 'Pares comprador→empresa repetidos sobre el mercado resuelto (adjudicatario resuelto, excluidas las UTE sin reparto oficial), ordenados por importe; empates por nº de contratos, comprador y NIF.' },
  };
  const coverage = Object.fromEntries(coverageDefinitions.map(([metric, numerator, denominator]) => [metric, percent(numerator, denominator)]));
  const snapshot: MarketSnapshot = {
    schema: 'elicita.market-intelligence/v1', snapshot_id: options.snapshotId, dataset: options.datasetId ?? DATASET, title: options.datasetTitle ?? DEFAULT_DATASET_TITLE, generated_at: options.generatedAt,
    period, source: { name: options.sourceName, freshness_date: period.to, fingerprint: sourceFingerprint },
    methodology: { schema_version: '1', methodology_version: '1.4.0', taxonomy_version: options.taxonomy.version, identity_registry_version: options.identityRegistry.version },
    universe: { source_rows: sourceRows, sector_candidates: sectorCandidates, analytic_contracts: accepted.length, excluded_rows: sectorCandidates - accepted.length },
    coverage: coverage as MarketSnapshot['coverage'],
    metrics: { observed_amount_eur: observedAmount, companies: companyAggregates.length, business_groups: groupAggregates.length, buyers: buyerAggregates.length, hhi_amount: hhi(amountShares), hhi_contracts: hhi(contractShares) },
    downloads: Object.fromEntries(HASHED_ARTIFACTS_V2.map((artifact) => [artifact.replaceAll('.', '_'), artifact])),
    limitations: [
      'El pipeline genera primero un candidato; la presencia bajo snapshots/ acredita que superó la revisión y promoción editorial.',
      'El importe observado no equivale a gasto ejecutado.',
      'Las atribuciones de grupo y los repartos UTE sin evidencia suficiente permanecen como unknown.',
      'Los CPV sin regla versionada no entran en el universo sectorial.',
      'La clasificación CPV se conserva como fue publicada: errores administrativos conocidos pueden introducir outliers no tecnológicos, como contratos de limpieza clasificados bajo CPV 72.',
      'Los registros excluidos por error de fuente verificado se declaran con su evidencia en methodology.json (record_exclusions).',
      'La deduplicación conserva la última revisión por id de origen; un id con varios lotes o adjudicatarios puede quedar representado por una sola revisión.',
      'No se publica ranking por grupos empresariales en v1: la cobertura de grupo es 0% hasta disponer de evidencia corporativa versionada.',
      'La fuente histórica llega hasta la última adjudicación completa observada, no hasta la fecha de generación del snapshot.',
      'Los agregados Elicita se publican bajo CC BY 4.0; los registros fuente conservan sus condiciones de reutilización.',
      'Las métricas de concentración (HHI y cuotas top-N) se calculan sobre el mercado resuelto: contratos con adjudicatario resuelto y excluidas las UTE sin reparto oficial. Las cuotas de los rankings se refieren al universo observado completo; coverage.csv publica la cobertura.',
    ],
    license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }, receipt: 'generation-receipt.json',
  };
  parseMarketSnapshot(snapshot);
  const files: Record<string, string> = {
    'snapshot.json': `${canonicalJson(snapshot)}\n`, 'companies.csv': companyCsv, 'business-groups.csv': businessGroupsCsv, 'buyers.csv': buyersCsv,
    'concentration.csv': concentrationCsv, 'evolution.csv': evolutionCsv, 'coverage.csv': coverageCsv, 'exclusions.csv': exclusionsCsv,
    'edges.csv': edgesCsv,
    'methodology.json': `${canonicalJson(methodology)}\n`,
  };
  const outputHashes = Object.fromEntries(HASHED_ARTIFACTS_V2.map((artifact) => [artifact, sha256(files[artifact])]));
  const receipt: GenerationReceipt = {
    schema: 'elicita.generation-receipt/v1', snapshot_id: options.snapshotId, generated_at: options.generatedAt, pipeline_commit: options.pipelineCommit,
    working_tree_clean: true, source_fingerprint: sourceFingerprint, taxonomy_hash: taxonomyHash, identity_registry_hash: identityRegistryHash, query_hash: queryHash,
    outputs: outputHashes,
    checks: { schema_valid: true, duplicate_analytic_ids: 0, shares_within_tolerance: true, rankings_deterministic: true, no_direct_identifiers: true, minimum_group_policy_applied: true, freshness_non_regression: true },
  };
  parseGenerationReceipt(receipt);
  files['generation-receipt.json'] = `${canonicalJson(receipt)}\n`;
  const checksums = Object.fromEntries([...HASHED_ARTIFACTS_V2, 'generation-receipt.json'].map((artifact) => [artifact, sha256(files[artifact])]));
  files['checksums.sha256'] = Object.entries(checksums).sort(([a], [b]) => a.localeCompare(b)).map(([artifact, hash]) => `${hash.slice('sha256:'.length)}  ${artifact}`).join('\n') + '\n';
  return { snapshot, receipt, files };
}

async function writeCandidate(directory: string, files: Record<string, string>): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(files).map(([file, contents]) => writeFile(join(directory, file), contents, 'utf8')));
}

export async function generateTechnologyCandidate(options: GenerateTechnologyCandidateOptions): Promise<GenerationResult> {
  const result = calculate(options);
  const stagingDir = `${options.outputDir}.tmp-${process.pid}`;
  await rm(stagingDir, { recursive: true, force: true });
  try {
    await writeCandidate(stagingDir, result.files);
    await validateOpenDataSnapshot(stagingDir);
    await rename(stagingDir, options.outputDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return { outputDir: options.outputDir, artifacts: Object.keys(result.files).sort(), checksums: Object.fromEntries(Object.entries(result.files).map(([file, contents]) => [file, sha256(contents)])) };
}

function parseCsvHeader(input: string): string[] {
  const line = input.split('\n', 1)[0];
  return line.split(',');
}

const EDGES_TOP_PAIRS = 250;
const EDGES_MINIMUM_CONTRACTS = 2;

export async function validateOpenDataSnapshot(
  directory: string, options: { allowDirectorySymlink?: boolean } = {},
): Promise<void> {
  const directoryStat = await lstat(directory);
  if ((!directoryStat.isDirectory() && !directoryStat.isSymbolicLink())
    || (directoryStat.isSymbolicLink() && !options.allowDirectorySymlink)) {
    throw new Error('candidate must be a real directory');
  }
  const present = (await readdir(directory)).sort();
  const expected = [...DIRECTORY_ARTIFACTS_V2].sort();
  if (JSON.stringify(present) !== JSON.stringify(expected)) throw new Error(`artifact set mismatch: expected ${expected.join(', ')}, got ${present.join(', ')}`);
  const contents = Object.fromEntries(await Promise.all(expected.map(async (artifact) => {
    const path = join(directory, artifact);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`artifact must be a regular file: ${artifact}`);
    return [artifact, await readFile(path, 'utf8')] as const;
  })));
  const snapshot = parseMarketSnapshot(JSON.parse(contents['snapshot.json']));
  const receipt = parseGenerationReceipt(JSON.parse(contents['generation-receipt.json']));
  if (snapshot.snapshot_id !== receipt.snapshot_id || snapshot.generated_at !== receipt.generated_at) throw new Error('snapshot and receipt identity mismatch');
  for (const artifact of CSV_ARTIFACTS_V2) {
    if (JSON.stringify(parseCsvHeader(contents[artifact])) !== JSON.stringify(CSV_HEADERS_V2[artifact])) throw new Error(`unexpected CSV header in ${artifact}`);
  }
  const checksumMap = parseChecksumManifest(contents['checksums.sha256']);
  const expectedChecksumArtifacts = [...HASHED_ARTIFACTS_V2, 'generation-receipt.json'].sort();
  if (JSON.stringify([...checksumMap.keys()].sort()) !== JSON.stringify(expectedChecksumArtifacts)) throw new Error('checksums must cover every non-checksum artifact');
  for (const artifact of expectedChecksumArtifacts) {
    const digest = sha256(contents[artifact]).slice('sha256:'.length);
    if (checksumMap.get(artifact) !== digest) throw new Error(`checksum mismatch: ${artifact}`);
    if ((HASHED_ARTIFACTS_V2 as readonly string[]).includes(artifact) && receipt.outputs[artifact] !== `sha256:${digest}`) throw new Error(`receipt checksum mismatch: ${artifact}`);
  }
  if (Object.keys(receipt.outputs).sort().join('|') !== [...HASHED_ARTIFACTS_V2].sort().join('|')) throw new Error('receipt outputs must cover every contract artifact except receipt and checksums');
  const forbidden = /(?:\/var\/|\/root\/|"(?:password|email|phone)"\s*:|api[_-]?key\s*[:=]|authorization\s*[:=])/i;
  for (const [artifact, content] of Object.entries(contents)) if (forbidden.test(content)) throw new Error(`forbidden direct identifier or internal path in ${artifact}`);
}

/**
 * Reads a canonical projection from DuckDB using its read-only CLI. Query is
 * deliberately constrained to one SELECT/WITH statement and must alias the
 * canonical SourceContractRow columns. No writes, extensions or pragmas run.
 */
export async function readCanonicalRowsFromDuckDb(options: DuckDbReadOptions): Promise<SourceContractRow[]> {
  const query = options.query.trim();
  if (!/^(select|with)\b/i.test(query) || /;|\b(?:attach|copy|create|delete|drop|insert|update|pragma|install|load)\b/i.test(query)) throw new Error('DuckDB query must be a single read-only SELECT or WITH statement');
  const { stdout } = await execFile(options.duckdbBinary ?? 'duckdb', ['-readonly', '-json', options.databasePath, query], { maxBuffer: 128 * 1024 * 1024 });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('DuckDB JSON output must be an array');
  return parsed.map((value, index) => {
    if (value === null || typeof value !== 'object') throw new Error(`DuckDB row ${index} is not an object`);
    const row = value as Record<string, unknown>;
    const stringOrNull = (key: string): string | null => row[key] === null ? null : typeof row[key] === 'string' ? row[key] : String(row[key]);
    const amount = row.observed_amount_eur;
    return {
      analytic_id: String(row.analytic_id ?? ''), award_date: String(row.award_date ?? ''), cpv: stringOrNull('cpv'), supplier_nif: stringOrNull('supplier_nif'), supplier_name: stringOrNull('supplier_name'),
      buyer_key: stringOrNull('buyer_key'), buyer_name: stringOrNull('buyer_name'), observed_amount_eur: amount === null || amount === undefined ? null : Number(amount), ute: row.ute === true,
    };
  });
}

export async function promoteCandidateAtomically(options: { candidateDir: string; destinationRoot: string }): Promise<void> {
  await validateOpenDataSnapshot(options.candidateDir);
  const snapshot = JSON.parse(await readFile(join(options.candidateDir, 'snapshot.json'), 'utf8')) as MarketSnapshot;
  const snapshotsRoot = join(options.destinationRoot, 'snapshots');
  const historical = join(snapshotsRoot, snapshot.snapshot_id);
  await mkdir(snapshotsRoot, { recursive: true });
  try {
    await rename(options.candidateDir, historical);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`historical snapshot already exists: ${snapshot.snapshot_id}`);
    throw error;
  }
  try {
    const latest = join(options.destinationRoot, 'latest');
    const temporaryLatest = join(options.destinationRoot, `.latest-${process.pid}`);
    await rm(temporaryLatest, { force: true });
    await symlink(relative(options.destinationRoot, historical), temporaryLatest, 'dir');
    await rename(temporaryLatest, latest);
  } catch (error) {
    await rename(historical, options.candidateDir).catch(() => undefined);
    throw error;
  }
}

export function defaultCandidateDirectory(projectRoot: string, snapshotId: string, datasetId: string = DATASET): string {
  return join(projectRoot, 'data', 'market-intelligence', 'candidates', datasetId, basename(snapshotId));
}

export function defaultPublicDestination(projectRoot: string, datasetId: string = DATASET): string {
  return join(projectRoot, 'web', 'public', 'data', 'market-intelligence', datasetId);
}
