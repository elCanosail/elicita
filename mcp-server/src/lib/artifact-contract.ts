/**
 * Single source of truth for the approved-snapshot artifact contract.
 *
 * The generator (open-data-generator.ts) and the loader (approved-snapshot.ts)
 * must never declare their own copies of these lists: drift between them turns
 * into either rejected snapshots or, worse, silently accepted sets.
 */

export const CSV_ARTIFACTS = ['companies.csv', 'business-groups.csv', 'buyers.csv', 'concentration.csv', 'evolution.csv', 'coverage.csv', 'exclusions.csv'] as const;

/**
 * Snapshot contract v2 adds edges.csv: deterministic buyer→company award pairs
 * for the sector graph. Legacy v1 published snapshots (without edges.csv) keep
 * loading until every sector is republished; the loader picks the set by the
 * manifest's own contents.
 */
export const EDGES_ARTIFACT = 'edges.csv' as const;
export const CSV_ARTIFACTS_V2 = [...CSV_ARTIFACTS, EDGES_ARTIFACT] as const;
export const HASHED_ARTIFACTS_V2 = ['snapshot.json', ...CSV_ARTIFACTS_V2, 'methodology.json'] as const;
export const REQUIRED_ARTIFACTS_V2 = [...HASHED_ARTIFACTS_V2, 'generation-receipt.json'] as const;
export const DIRECTORY_ARTIFACTS_V2 = [...HASHED_ARTIFACTS_V2, 'generation-receipt.json', 'checksums.sha256'] as const;

/** Artifacts covered by hashes in `checksums.sha256` and declared in `receipt.outputs`. */
export const HASHED_ARTIFACTS = ['snapshot.json', ...CSV_ARTIFACTS, 'methodology.json'] as const;

/** Files the approved-snapshot loader reads and verifies byte-for-byte. */
export const REQUIRED_ARTIFACTS = [...HASHED_ARTIFACTS, 'generation-receipt.json'] as const;

/** Complete on-disk set of a generated snapshot directory (adds the manifest itself, which cannot hash itself). */
export const DIRECTORY_ARTIFACTS = [...HASHED_ARTIFACTS, 'generation-receipt.json', 'checksums.sha256'] as const;

export const CSV_HEADERS: Record<(typeof CSV_ARTIFACTS)[number], readonly string[]> = {
  'companies.csv': ['rank', 'nif', 'company_name', 'analytic_contracts', 'observed_amount_eur', 'share_amount_pct', 'share_contracts_pct', 'group_id', 'group_name'],
  'business-groups.csv': ['rank', 'group_id', 'group_name', 'company_count', 'analytic_contracts', 'observed_amount_eur', 'share_amount_pct', 'share_contracts_pct'],
  'buyers.csv': ['rank', 'buyer_id', 'buyer_name', 'analytic_contracts', 'observed_amount_eur', 'share_market_amount_pct'],
  'concentration.csv': ['period', 'dimension', 'hhi', 'top1_share_pct', 'top5_share_pct', 'top10_share_pct', 'valid_denominator'],
  'evolution.csv': ['year', 'entity_type', 'entity_id', 'entity_name', 'analytic_contracts', 'observed_amount_eur', 'share_amount_pct', 'share_contracts_pct'],
  'coverage.csv': ['metric', 'numerator', 'denominator', 'coverage_pct', 'unknown_count', 'definition'],
  'exclusions.csv': ['reason_code', 'reason_label', 'rows', 'amount_eur', 'share_source_rows_pct'],
} as const;

export const CSV_HEADERS_V2: Record<string, readonly string[]> = {
  ...CSV_HEADERS,
  [EDGES_ARTIFACT]: ['rank', 'buyer_id', 'buyer_name', 'nif', 'company_name', 'analytic_contracts', 'observed_amount_eur'],
};

/**
 * Parses a `checksums.sha256` manifest into bare lowercase hex digests.
 * Strict format: one entry per LF line, `<64 hex>␣␣<artifact name>`; no CR, no trailing blank entries.
 * Callers enforce their own membership policy over the returned map.
 */
export function parseChecksumManifest(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([a-z0-9][a-z0-9.-]*)$/.exec(line);
    if (!match) throw new Error(`checksums.sha256 contains an invalid entry: ${line}`);
    if (entries.has(match[2]!)) throw new Error(`checksums.sha256 contains a duplicate artifact: ${match[2]}`);
    entries.set(match[2]!, match[1]!);
  }
  return entries;
}
