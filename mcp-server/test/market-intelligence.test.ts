import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGenerationReceipt, parseMarketSnapshot } from '../src/lib/market-intelligence.js';

const hash = `sha256:${'a'.repeat(64)}`;

function fixture() {
  return {
    schema: 'elicita.market-intelligence/v1',
    snapshot_id: 'technology-20260914-220000Z',
    dataset: 'technology',
    title: 'Tecnología y telecomunicaciones',
    generated_at: '2026-09-14T22:00:00Z',
    period: { from: '2022-01-01', to: '2026-09-14' },
    source: { name: 'Elicita contratos_vivos', freshness_date: '2026-09-14', fingerprint: hash },
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
      buyers: 15, hhi_amount: 1200, hhi_contracts: 900,
    },
    downloads: { companies_csv: 'companies.csv' },
    limitations: ['Los importes observados no equivalen a gasto ejecutado.'],
    license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    receipt: 'generation-receipt.json',
  };
}

test('accepts a reconciled technology snapshot', () => {
  assert.equal(parseMarketSnapshot(fixture()).dataset, 'technology');
});

test('rejects unknown fields so web and MCP cannot silently diverge', () => {
  assert.throws(() => parseMarketSnapshot({ ...fixture(), hidden_metric: 1 }));
});

test('rejects invalid percentages, HHI and unreconciled universe', () => {
  assert.throws(() => parseMarketSnapshot({ ...fixture(), coverage: { ...fixture().coverage, amount_valid_pct: 101 } }));
  assert.throws(() => parseMarketSnapshot({ ...fixture(), metrics: { ...fixture().metrics, hhi_amount: 10_001 } }));
  assert.throws(() => parseMarketSnapshot({ ...fixture(), universe: { ...fixture().universe, excluded_rows: 9 } }));
});

test('rejects reversed periods and freshness beyond the declared period', () => {
  assert.throws(() => parseMarketSnapshot({ ...fixture(), period: { from: '2026-09-15', to: '2026-09-14' } }));
  assert.throws(() => parseMarketSnapshot({ ...fixture(), source: { ...fixture().source, freshness_date: '2026-09-15' } }));
});

function receiptFixture() {
  return {
    schema: 'elicita.generation-receipt/v1',
    snapshot_id: 'technology-20260914-220000Z',
    generated_at: '2026-09-14T22:00:00Z',
    pipeline_commit: 'b'.repeat(40),
    working_tree_clean: true,
    source_fingerprint: hash,
    taxonomy_hash: hash,
    identity_registry_hash: hash,
    query_hash: hash,
    outputs: { 'snapshot.json': hash, 'companies.csv': hash },
    checks: {
      schema_valid: true,
      duplicate_analytic_ids: 0,
      shares_within_tolerance: true,
      rankings_deterministic: true,
      no_direct_identifiers: true,
      minimum_group_policy_applied: true,
      freshness_non_regression: true,
    },
  };
}

test('accepts only publication-ready generation receipts', () => {
  assert.equal(parseGenerationReceipt(receiptFixture()).working_tree_clean, true);
});

test('rejects dirty, failed or hashless generation receipts', () => {
  assert.throws(() => parseGenerationReceipt({ ...receiptFixture(), working_tree_clean: false }));
  assert.throws(() => parseGenerationReceipt({
    ...receiptFixture(), checks: { ...receiptFixture().checks, rankings_deterministic: false },
  }));
  assert.throws(() => parseGenerationReceipt({ ...receiptFixture(), outputs: {} }));
  assert.throws(() => parseGenerationReceipt({ ...receiptFixture(), pipeline_commit: 'short' }));
});
