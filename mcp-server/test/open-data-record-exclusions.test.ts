import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateTechnologyCandidate } from '../src/lib/open-data-generator.js';
import { parseRecordExclusionRegistry, type RecordExclusionRegistry } from '../src/lib/market-intelligence.js';
import { technologyFixtureRows, technologyIdentityRegistry, technologyTaxonomy } from '../src/lib/open-data-fixture.js';
import { constructionRecordExclusions } from '../src/lib/open-data-record-exclusions.js';

const commit = 'a'.repeat(40);
const generatedAt = '2026-09-16T12:00:00Z';

async function generate(outputDir: string, snapshotId: string, recordExclusions?: RecordExclusionRegistry) {
  await rm(outputDir, { recursive: true, force: true });
  return generateTechnologyCandidate({
    outputDir,
    rows: technologyFixtureRows,
    taxonomy: technologyTaxonomy,
    identityRegistry: technologyIdentityRegistry,
    generatedAt,
    snapshotId,
    pipelineCommit: commit,
    sourceName: 'fixture: technology-v1',
    workingTreeClean: true,
    recordExclusions,
  });
}

test('construction record exclusion registry parses with evidence and rejects drift', () => {
  const registry = parseRecordExclusionRegistry(constructionRecordExclusions);
  assert.equal(registry.dataset, 'construction');
  assert.equal(registry.entries.length, 1);
  assert.equal(registry.entries[0].reason_code, 'source_amount_error');
  assert.ok(registry.entries[0].evidence_url.startsWith('https://'));
  assert.throws(() => parseRecordExclusionRegistry({ ...constructionRecordExclusions, dataset: 'agricultura' }));
  assert.throws(() => parseRecordExclusionRegistry({ ...constructionRecordExclusions, schema: 'elicita.record-exclusion-registry/v2' }));
  assert.throws(() => parseRecordExclusionRegistry({ ...constructionRecordExclusions, entries: [{ ...constructionRecordExclusions.entries[0], evidence_url: 'no-es-una-url' }] }));
});

test('record exclusion registry removes one valid row and declares the correction', async () => {
  const baseline = await generate('/tmp/faro-test-record-exclusion-baseline', 'technology-20260916-120000Z');
  const target = technologyFixtureRows.find((row) => row.observed_amount_eur !== null && (row.observed_amount_eur ?? 0) > 0);
  assert.ok(target);
  const registry: RecordExclusionRegistry = {
    schema: 'elicita.record-exclusion-registry/v1',
    version: 1,
    dataset: 'technology',
    entries: [
      {
        record_id: target.analytic_id,
        reason_code: 'source_amount_error',
        reason_label: 'exclusión de prueba',
        declared_amount_eur: target.observed_amount_eur ?? 0,
        verified_amount_eur: 0,
        evidence_url: 'https://example.test/evidencia',
        decision_date: '2026-09-16',
        decision_source: 'test',
      },
    ],
  };
  const corrected = await generate('/tmp/faro-test-record-exclusion-corrected', 'technology-20260916-120001Z', registry);
  const baselineSnapshot = JSON.parse(await readFile(join(baseline.outputDir, 'snapshot.json'), 'utf8'));
  const correctedSnapshot = JSON.parse(await readFile(join(corrected.outputDir, 'snapshot.json'), 'utf8'));
  assert.equal(correctedSnapshot.universe.analytic_contracts, baselineSnapshot.universe.analytic_contracts - 1);
  assert.equal(correctedSnapshot.universe.excluded_rows, baselineSnapshot.universe.excluded_rows + 1);
  assert.ok(Math.abs(correctedSnapshot.metrics.observed_amount_eur - (baselineSnapshot.metrics.observed_amount_eur - (target.observed_amount_eur ?? 0))) < 0.01);
  const exclusionsCsv = await readFile(join(corrected.outputDir, 'exclusions.csv'), 'utf8');
  assert.ok(exclusionsCsv.includes('source_amount_error'));
  const methodology = JSON.parse(await readFile(join(corrected.outputDir, 'methodology.json'), 'utf8'));
  assert.equal(methodology.record_exclusions.entries[0].record_id, target.analytic_id);
  assert.match(methodology.record_exclusions.fingerprint, /^sha256:[a-f0-9]{64}$/);
  const baselineMethodology = JSON.parse(await readFile(join(baseline.outputDir, 'methodology.json'), 'utf8'));
  assert.equal(baselineMethodology.record_exclusions, null);
  await assert.rejects(() => generate('/tmp/faro-test-record-exclusion-mismatch', 'technology-20260916-120002Z', { ...registry, dataset: 'construction' }));
});
