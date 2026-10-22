import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  downloadArtifacts,
  loadPublishedMarketSnapshot,
  validatePublishedMarketSnapshot,
} from '../market-intelligence';

const hash = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

function buildFixture() {
  const snapshot = {
    schema: 'elicita.market-intelligence/v1',
    snapshot_id: 'technology-20260914-220000Z',
    dataset: 'technology',
    title: 'Tecnología y telecomunicaciones',
    generated_at: '2026-09-14T22:00:00Z',
    period: { from: '2022-01-01', to: '2026-09-14' },
    source: { name: 'Elicita contratos_vivos', freshness_date: '2026-09-14', fingerprint: `sha256:${'a'.repeat(64)}` },
    methodology: {
      schema_version: '1', methodology_version: '1.0.0',
      taxonomy_version: '1.0.0', identity_registry_version: '1.0.0',
    },
    universe: { source_rows: 100, sector_candidates: 80, analytic_contracts: 70, excluded_rows: 10 },
    coverage: {
      cpv_resolved_pct: 100, amount_valid_pct: 95, supplier_nif_valid_pct: 80,
      supplier_resolved_pct: 78, business_group_resolved_pct: 65,
      buyer_resolved_pct: 90, ute_unresolved_amount_pct: 3,
    },
    metrics: {
      observed_amount_eur: 1_000_000, companies: 20, business_groups: 12,
      buyers: 15, hhi_amount: 1_200, hhi_contracts: 900,
    },
    downloads: { companies_csv: 'companies.csv' },
    limitations: ['Los importes observados no equivalen a gasto ejecutado.'],
    license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    receipt: 'generation-receipt.json',
  };

  const files: Record<string, string> = {
    'snapshot.json': JSON.stringify(snapshot),
    'companies.csv': 'rank,nif\n1,A00000000\n',
    'business-groups.csv': 'rank,group_id\n1,group-1\n',
    'buyers.csv': 'rank,buyer_id\n1,buyer-1\n',
    'concentration.csv': 'period,dimension,hhi\n2026,amount,1200\n',
    'evolution.csv': 'year,entity_type\n2026,company\n',
    'coverage.csv': 'metric,coverage_pct\namount,95\n',
    'exclusions.csv': 'reason_code,rows\nmissing_cpv,10\n',
    'edges.csv': 'source_nif,target_nif\nA00000000,B00000000\n',
    'methodology.json': '{"version":"1.0.0"}\n',
  };

  const outputs = Object.fromEntries(Object.entries(files).map(([filename, content]) => [filename, hash(content)]));
  files['generation-receipt.json'] = JSON.stringify({
    schema: 'elicita.generation-receipt/v1',
    snapshot_id: snapshot.snapshot_id,
    generated_at: snapshot.generated_at,
    pipeline_commit: 'b'.repeat(40),
    working_tree_clean: true,
    source_fingerprint: snapshot.source.fingerprint,
    taxonomy_hash: `sha256:${'c'.repeat(64)}`,
    identity_registry_hash: `sha256:${'d'.repeat(64)}`,
    query_hash: `sha256:${'e'.repeat(64)}`,
    outputs,
    checks: {
      schema_valid: true,
      duplicate_analytic_ids: 0,
      shares_within_tolerance: true,
      rankings_deterministic: true,
      no_direct_identifiers: true,
      minimum_group_policy_applied: true,
      freshness_non_regression: true,
    },
  });
  files['checksums.sha256'] = [...downloadArtifacts]
    .filter(({ filename }) => filename !== 'checksums.sha256')
    .map(({ filename }) => `${hash(files[filename])?.slice('sha256:'.length)}  ${filename}`)
    .join('\n') + '\n';

  return files;
}

function reader(files: Record<string, string>) {
  return async (filename: string) => {
    if (!(filename in files)) throw new Error(`Missing ${filename}`);
    return files[filename];
  };
}

describe('published market intelligence snapshots', () => {
  it('accepts only a complete snapshot whose hashes, receipt and checksum manifest agree', async () => {
    const value = await validatePublishedMarketSnapshot(reader(buildFixture()));

    expect(value.snapshot.snapshot_id).toBe('technology-20260914-220000Z');
    expect(value.receipt.checks.rankings_deterministic).toBe(true);
  });

  it('rejects a malformed or tampered snapshot instead of exposing its figures', async () => {
    const malformed = buildFixture();
    malformed['snapshot.json'] = malformed['snapshot.json'].replace('"amount_valid_pct":95', '"amount_valid_pct":101');
    await expect(validatePublishedMarketSnapshot(reader(malformed))).rejects.toThrow();

    const tampered = buildFixture();
    tampered['companies.csv'] += '2,A00000001\n';
    await expect(validatePublishedMarketSnapshot(reader(tampered))).rejects.toThrow('No se pudo verificar la integridad de companies.csv.');

    const tamperedReceipt = buildFixture();
    tamperedReceipt['generation-receipt.json'] = tamperedReceipt['generation-receipt.json'].replace('"working_tree_clean":true', '"working_tree_clean":false');
    await expect(validatePublishedMarketSnapshot(reader(tamperedReceipt))).rejects.toThrow('generation-receipt.json');

    const duplicateManifest = buildFixture();
    duplicateManifest['checksums.sha256'] += duplicateManifest['checksums.sha256'].split('\n')[0] + '\n';
    await expect(validatePublishedMarketSnapshot(reader(duplicateManifest))).rejects.toThrow('Checksum duplicado');
  });

  it('falls back honestly when the published directory does not contain a valid snapshot', async () => {
    const result = await loadPublishedMarketSnapshot(reader({}));

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toContain('No hay un snapshot');
    }
  });
});
