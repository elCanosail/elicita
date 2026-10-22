import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  parseGenerationReceipt,
  parseMarketSnapshot,
  type GenerationReceipt,
  type MarketSnapshot,
} from './market-intelligence.js';
import { CSV_HEADERS, CSV_HEADERS_V2, EDGES_ARTIFACT, HASHED_ARTIFACTS, HASHED_ARTIFACTS_V2, REQUIRED_ARTIFACTS, REQUIRED_ARTIFACTS_V2, parseChecksumManifest } from './artifact-contract.js';

export const SNAPSHOT_DIRECTORY_ENV = 'ELICITA_APPROVED_SNAPSHOT_DIR';

export interface ApprovedSnapshotConfig {
  /** Absolute path to the editorially-approved snapshot directory. */
  approvedSnapshotDir: string;
}

export interface CsvTable {
  headers: readonly string[];
  rows: Array<Record<string, string>>;
}

export interface ApprovedSnapshot {
  directory: string;
  snapshot: MarketSnapshot;
  receipt: GenerationReceipt;
  tables: Record<string, CsvTable>;
}

export class ApprovedSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovedSnapshotError';
  }
}

/**
 * Loads only fixed, verified files below one operator-selected directory.
 * It intentionally has no network, database or fallback path.
 */
export async function loadApprovedSnapshot(config: ApprovedSnapshotConfig): Promise<ApprovedSnapshot> {
  const directory = await resolveApprovedDirectory(config.approvedSnapshotDir);
  const checksums = parseChecksums(await readApprovedFile(directory, 'checksums.sha256'));

  // Contract version by manifest contents: v2 snapshots declare edges.csv;
  // legacy v1 published snapshots must keep loading until all sectors republish.
  const isV2 = checksums.has(EDGES_ARTIFACT);
  const required = isV2 ? REQUIRED_ARTIFACTS_V2 : REQUIRED_ARTIFACTS;
  const hashed = isV2 ? HASHED_ARTIFACTS_V2 : HASHED_ARTIFACTS;
  const headers = isV2 ? CSV_HEADERS_V2 : CSV_HEADERS;

  const bytes = new Map<string, Buffer>();
  for (const name of required) {
    const content = await readApprovedFile(directory, name);
    const expected = checksums.get(name);
    if (!expected) throw new ApprovedSnapshotError(`checksums.sha256 does not declare ${name}`);
    if (sha256(content) !== expected) throw new ApprovedSnapshotError(`checksum mismatch for ${name}`);
    bytes.set(name, content);
  }

  if (checksums.size !== required.length) {
    throw new ApprovedSnapshotError('checksums.sha256 must declare exactly the approved contract artifacts');
  }

  const snapshot = parseJson<MarketSnapshot>(bytes.get('snapshot.json')!, 'snapshot.json', parseMarketSnapshot);
  const receipt = parseJson<GenerationReceipt>(bytes.get('generation-receipt.json')!, 'generation-receipt.json', parseGenerationReceipt);
  validateReceipt(snapshot, receipt, checksums, hashed);
  validateDownloads(snapshot, hashed);
  validateMethodology(bytes.get('methodology.json')!);

  const tables: Record<string, CsvTable> = {};
  for (const [name, tableHeaders] of Object.entries(headers)) {
    tables[name] = parseCsv(bytes.get(name)!.toString('utf8'), name, tableHeaders);
  }
  validateTables(snapshot, tables);

  return { directory, snapshot, receipt, tables };
}

export function approvedSnapshotConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ApprovedSnapshotConfig {
  const approvedSnapshotDir = environment[SNAPSHOT_DIRECTORY_ENV];
  if (!approvedSnapshotDir) {
    throw new ApprovedSnapshotError(`${SNAPSHOT_DIRECTORY_ENV} is required before market intelligence tools can be registered`);
  }
  return { approvedSnapshotDir };
}

export type ApprovedSnapshotDataset = 'technology' | 'construction' | 'salud' | 'energia' | 'limpieza' | 'defensa' | 'transporte';
export type ApprovedSnapshotConfigs = Partial<Record<ApprovedSnapshotDataset, ApprovedSnapshotConfig>>;

/**
 * Resolves the editorially-approved snapshot directories per dataset from the
 * environment. Datasets without a configured directory stay unregistered.
 */
export function approvedSnapshotConfigsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ApprovedSnapshotConfigs {
  const configs: ApprovedSnapshotConfigs = {};
  const technology = environment.ELICITA_APPROVED_SNAPSHOT_DIR;
  const construction = environment.ELICITA_APPROVED_SNAPSHOT_DIR_CONSTRUCTION;
  const salud = environment.ELICITA_APPROVED_SNAPSHOT_DIR_SALUD;
  const energia = environment.ELICITA_APPROVED_SNAPSHOT_DIR_ENERGIA;
  const limpieza = environment.ELICITA_APPROVED_SNAPSHOT_DIR_LIMPIEZA;
  const defensa = environment.ELICITA_APPROVED_SNAPSHOT_DIR_DEFENSA;
  const transporte = environment.ELICITA_APPROVED_SNAPSHOT_DIR_TRANSPORTE;
  if (technology) configs.technology = { approvedSnapshotDir: technology };
  if (construction) configs.construction = { approvedSnapshotDir: construction };
  if (salud) configs.salud = { approvedSnapshotDir: salud };
  if (energia) configs.energia = { approvedSnapshotDir: energia };
  if (limpieza) configs.limpieza = { approvedSnapshotDir: limpieza };
  if (defensa) configs.defensa = { approvedSnapshotDir: defensa };
  if (transporte) configs.transporte = { approvedSnapshotDir: transporte };
  return configs;
}

async function resolveApprovedDirectory(input: string): Promise<string> {
  if (!input || !isAbsolute(input)) {
    throw new ApprovedSnapshotError('approvedSnapshotDir must be an absolute path');
  }
  let directory: string;
  try {
    directory = await realpath(input);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ApprovedSnapshotError('approvedSnapshotDir must be a real directory');
  } catch (error) {
    if (error instanceof ApprovedSnapshotError) throw error;
    throw new ApprovedSnapshotError('approvedSnapshotDir is unavailable');
  }
  return directory;
}

async function readApprovedFile(directory: string, name: string): Promise<Buffer> {
  const path = resolve(directory, name);
  if (relative(directory, path).startsWith('..')) throw new ApprovedSnapshotError(`invalid artifact path: ${name}`);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ApprovedSnapshotError(`artifact must be a regular file: ${name}`);
    return await readFile(path);
  } catch (error) {
    if (error instanceof ApprovedSnapshotError) throw error;
    throw new ApprovedSnapshotError(`required artifact is unavailable: ${name}`);
  }
}

function parseChecksums(content: Buffer): Map<string, string> {
  const text = content.toString('utf8');
  if (!text.endsWith('\n') || text.includes('\r')) throw new ApprovedSnapshotError('checksums.sha256 must use UTF-8 LF lines');

  let manifest: Map<string, string>;
  try {
    manifest = parseChecksumManifest(text);
  } catch (error) {
    throw new ApprovedSnapshotError((error as Error).message);
  }
  for (const filename of manifest.keys()) {
    const allowedNames = new Set<string>([...REQUIRED_ARTIFACTS, ...REQUIRED_ARTIFACTS_V2]);
    if (!allowedNames.has(filename)) {
      throw new ApprovedSnapshotError('checksums.sha256 contains an unexpected or duplicate artifact');
    }
  }
  return manifest;
}

function validateReceipt(snapshot: MarketSnapshot, receipt: GenerationReceipt, checksums: Map<string, string>, hashed: readonly string[]): void {
  if (receipt.snapshot_id !== snapshot.snapshot_id) throw new ApprovedSnapshotError('receipt snapshot_id does not match snapshot.json');
  if (receipt.source_fingerprint !== snapshot.source.fingerprint) throw new ApprovedSnapshotError('receipt source fingerprint does not match snapshot.json');

  const outputNames = Object.keys(receipt.outputs).sort();
  const expectedNames = [...hashed].sort();
  if (outputNames.length !== expectedNames.length || outputNames.some((name, index) => name !== expectedNames[index])) {
    throw new ApprovedSnapshotError('receipt outputs must cover exactly the contract data artifacts');
  }
  for (const name of hashed) {
    if (receipt.outputs[name] !== `sha256:${checksums.get(name)}`) {
      throw new ApprovedSnapshotError(`receipt output hash does not match checksums.sha256 for ${name}`);
    }
  }
}

function validateDownloads(snapshot: MarketSnapshot, hashed: readonly string[]): void {
  const allowed = new Set(hashed);
  for (const artifact of Object.values(snapshot.downloads)) {
    if (!allowed.has(artifact as typeof HASHED_ARTIFACTS[number])) {
      throw new ApprovedSnapshotError(`snapshot.json declares an unapproved download: ${artifact}`);
    }
  }
}

function validateMethodology(content: Buffer): void {
  const methodology = parseJson<unknown>(content, 'methodology.json', value => value);
  if (!methodology || typeof methodology !== 'object' || Array.isArray(methodology)) {
    throw new ApprovedSnapshotError('methodology.json must be a JSON object');
  }
}

function validateTables(snapshot: MarketSnapshot, tables: Record<string, CsvTable>): void {
  for (const row of tables['companies.csv'].rows) validateRankedRow(row, 'company_name');
  for (const row of tables['business-groups.csv'].rows) validateRankedRow(row, 'group_name');
  for (const row of tables['buyers.csv'].rows) validateRankedRow(row, 'buyer_name');

  const coverageRows = new Map(tables['coverage.csv'].rows.map(row => [row.metric, row]));
  for (const [metric, expected] of Object.entries(snapshot.coverage)) {
    const row = coverageRows.get(metric);
    if (!row) throw new ApprovedSnapshotError(`coverage.csv is missing ${metric}`);
    if (Math.abs(finiteNumber(row.coverage_pct, `coverage.csv ${metric} coverage_pct`) - expected) > 1e-7) {
      throw new ApprovedSnapshotError(`coverage.csv ${metric} does not match snapshot.json`);
    }
    finiteNumber(row.numerator, `coverage.csv ${metric} numerator`);
    finiteNumber(row.denominator, `coverage.csv ${metric} denominator`);
    finiteNumber(row.unknown_count, `coverage.csv ${metric} unknown_count`);
    if (!row.definition) throw new ApprovedSnapshotError(`coverage.csv ${metric} has no definition`);
  }
}

function validateRankedRow(row: Record<string, string>, nameColumn: string): void {
  positiveInteger(row.rank, 'rank');
  if (!row[nameColumn]) throw new ApprovedSnapshotError(`${nameColumn} must not be empty`);
  nonNegativeInteger(row.analytic_contracts, 'analytic_contracts');
  nonNegativeNumber(row.observed_amount_eur, 'observed_amount_eur');
  if ('share_amount_pct' in row) percentageNumber(row.share_amount_pct!, 'share_amount_pct');
  if ('share_contracts_pct' in row) percentageNumber(row.share_contracts_pct, 'share_contracts_pct');
  if ('share_market_amount_pct' in row) percentageNumber(row.share_market_amount_pct, 'share_market_amount_pct');
}

function parseCsv(content: string, name: string, expectedHeaders: readonly string[]): CsvTable {
  if (!content.endsWith('\n') || content.includes('\r')) throw new ApprovedSnapshotError(`${name} must use UTF-8 LF lines`);
  const records: string[][] = [[]];
  let field = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"'; index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') {
      if (field) throw new ApprovedSnapshotError(`${name} has invalid CSV quoting`);
      quoted = true;
    } else if (character === ',') {
      records.at(-1)!.push(field); field = '';
    } else if (character === '\n') {
      records.at(-1)!.push(field); field = '';
      if (index !== content.length - 1) records.push([]);
    } else field += character;
  }
  if (quoted) throw new ApprovedSnapshotError(`${name} has unterminated CSV quoting`);
  const [headers, ...rows] = records;
  if (!headers || headers.length !== expectedHeaders.length || headers.some((header, index) => header !== expectedHeaders[index])) {
    throw new ApprovedSnapshotError(`${name} has unexpected columns`);
  }
  return {
    headers,
    rows: rows.map((values, index) => {
      if (values.length !== headers.length) throw new ApprovedSnapshotError(`${name} row ${index + 2} has unexpected columns`);
      return Object.fromEntries(headers.map((header, valueIndex) => [header, values[valueIndex]!])) as Record<string, string>;
    }),
  };
}

function parseJson<T>(content: Buffer, name: string, parser: (input: unknown) => T): T {
  try {
    return parser(JSON.parse(content.toString('utf8')));
  } catch (error) {
    if (error instanceof ApprovedSnapshotError) throw error;
    throw new ApprovedSnapshotError(`${name} does not satisfy its contract`);
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function finiteNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ApprovedSnapshotError(`${label} must be finite`);
  return parsed;
}

function nonNegativeNumber(value: string, label: string): number {
  const parsed = finiteNumber(value, label);
  if (parsed < 0) throw new ApprovedSnapshotError(`${label} must not be negative`);
  return parsed;
}

function percentageNumber(value: string, label: string): number {
  const parsed = nonNegativeNumber(value, label);
  if (parsed > 100) throw new ApprovedSnapshotError(`${label} must not exceed 100`);
  return parsed;
}

function positiveInteger(value: string, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ApprovedSnapshotError(`${label} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string, label: string): number {
  const parsed = nonNegativeNumber(value, label);
  if (!Number.isInteger(parsed)) throw new ApprovedSnapshotError(`${label} must be an integer`);
  return parsed;
}
