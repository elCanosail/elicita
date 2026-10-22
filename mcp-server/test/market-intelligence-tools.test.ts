import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { loadApprovedSnapshot, ApprovedSnapshotError } from '../src/lib/approved-snapshot.js';
import {
  analyzeBuyer,
  marketSnapshot,
  rankCompanies,
  traceMetric,
} from '../src/tools/market-intelligence.js';

const fixtureDirectory = resolve(import.meta.dirname, 'fixtures/market-intelligence/approved');
const fixtureConfig = { approvedSnapshotDir: fixtureDirectory };

test('approved snapshot loader validates the contract, receipt and all checksums', async () => {
  const loaded = await loadApprovedSnapshot(fixtureConfig);
  assert.equal(loaded.snapshot.snapshot_id, 'technology-20260914-220000Z');
  assert.equal(loaded.receipt.outputs['companies.csv'].startsWith('sha256:'), true);
  assert.equal(loaded.tables['companies.csv'].rows.length, 2);
  assert.equal(loaded.tables['coverage.csv'].rows.length, 7);
});

test('approved snapshot loader fails closed on a tampered approved artifact', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'elicita-approved-snapshot-'));
  try {
    await regenerate(directory);
    await writeFile(resolve(directory, 'buyers.csv'), 'tampered\n', 'utf8');
    await assert.rejects(() => loadApprovedSnapshot({ approvedSnapshotDir: directory }), ApprovedSnapshotError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fixture generator reproduces the committed snapshot artifacts byte-for-byte', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'elicita-approved-snapshot-'));
  try {
    await regenerate(directory);
    const names = await readdir(fixtureDirectory);
    assert.deepEqual((await readdir(directory)).sort(), names.sort());
    for (const name of names) {
      assert.deepEqual(await readFile(resolve(directory, name)), await readFile(resolve(fixtureDirectory, name)), name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('P2 tools are equivalent to the approved fixture artifacts and carry full provenance', async () => {
  const rawSnapshot = JSON.parse(await readFile(resolve(fixtureDirectory, 'snapshot.json'), 'utf8')) as Record<string, unknown>;
  const snapshotResult = await marketSnapshot(fixtureConfig);
  assert.equal(snapshotResult.isError, undefined);
  const structured = snapshotResult.structuredContent as Record<string, unknown>;
  assert.deepEqual(structured.snapshot, rawSnapshot);
  assertProvenance(structured.provenance);

  const rankingResult = await rankCompanies(fixtureConfig, { limit: 1 });
  const ranking = rankingResult.structuredContent as Record<string, unknown>;
  assert.deepEqual(ranking.rows, [{
    rank: 1, nif: 'B00000001', company_name: 'Fixture Systems SA', analytic_contracts: 3,
    observed_amount_eur: 400000, share_amount_pct: 40, share_contracts_pct: 37.5,
    group_id: 'g-fixture', group_name: 'Grupo Fixture',
  }]);
  assertProvenance(ranking.provenance);

  const buyerResult = await analyzeBuyer(fixtureConfig, { buyer_id: 'buyer-fixture-1' });
  const buyer = buyerResult.structuredContent as Record<string, unknown>;
  assert.deepEqual(buyer.buyer, {
    rank: 1, buyer_id: 'buyer-fixture-1', buyer_name: 'Comprador Fixture Uno', analytic_contracts: 4,
    observed_amount_eur: 500000, share_market_amount_pct: 50,
  });
  assertProvenance(buyer.provenance);

  const traceResult = await traceMetric(fixtureConfig, { metric: 'buyer_resolved_pct' });
  const trace = (traceResult.structuredContent as Record<string, unknown>).trace as Record<string, unknown>;
  assert.deepEqual(trace, {
    metric: 'buyer_resolved_pct', value: 87.5, unit: 'pct', numerator: 7, denominator: 8,
    unknown_count: 1, definition: 'Comprador con identificador canónico versionado.',
    artifacts: ['snapshot.json', 'coverage.csv', 'generation-receipt.json', 'checksums.sha256'],
  });
  assertProvenance((traceResult.structuredContent as Record<string, unknown>).provenance);

  const hhiResult = await traceMetric(fixtureConfig, { metric: 'hhi_amount' });
  const hhiTrace = (hhiResult.structuredContent as Record<string, unknown>).trace as Record<string, unknown>;
  assert.equal(hhiTrace.denominator, 1_000_000);
  assert.deepEqual(hhiTrace.concentration_rows, [{
    period: '2022-01-01/2026-09-14', hhi: 2000, valid_denominator: 1_000_000,
  }]);
});

test('P2 tools never use an implicit current directory or fallback snapshot', async () => {
  const result = await marketSnapshot({ approvedSnapshotDir: '' });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /approvedSnapshotDir/);
});

function assertProvenance(value: unknown): void {
  assert.ok(value && typeof value === 'object');
  const provenance = value as Record<string, unknown>;
  assert.deepEqual(provenance.period, { from: '2022-01-01', to: '2026-09-14' });
  assert.ok(provenance.denominators);
  assert.ok(provenance.coverage);
  assert.deepEqual(provenance.source, {
    name: 'Synthetic fixture only', freshness_date: '2026-09-14', fingerprint: `sha256:${'a'.repeat(64)}`,
  });
  assert.ok(Array.isArray(provenance.limitations));
  assert.deepEqual((provenance.snapshot as Record<string, unknown>).id, 'technology-20260914-220000Z');
}

async function regenerate(directory: string): Promise<void> {
  const generator = await import('./fixtures/market-intelligence/generate-fixture.mjs');
  await generator.writeFixture(directory);
}
