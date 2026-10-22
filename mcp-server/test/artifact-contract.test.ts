import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CSV_ARTIFACTS,
  CSV_HEADERS,
  DIRECTORY_ARTIFACTS,
  HASHED_ARTIFACTS,
  REQUIRED_ARTIFACTS,
  parseChecksumManifest,
} from '../src/lib/artifact-contract.js';

test('artifact contract: explicit relationships between artifact sets', () => {
  assert.ok((HASHED_ARTIFACTS as readonly string[]).includes('snapshot.json'));
  assert.ok((HASHED_ARTIFACTS as readonly string[]).includes('methodology.json'));
  for (const artifact of CSV_ARTIFACTS) {
    assert.ok((HASHED_ARTIFACTS as readonly string[]).includes(artifact), `csv artifact ${artifact} must be hashed`);
  }
  assert.equal(HASHED_ARTIFACTS.length, new Set(HASHED_ARTIFACTS).size, 'hashed artifacts must not repeat');
  assert.deepEqual([...REQUIRED_ARTIFACTS].sort(), [...HASHED_ARTIFACTS, 'generation-receipt.json'].sort());
  assert.deepEqual([...DIRECTORY_ARTIFACTS].sort(), [...REQUIRED_ARTIFACTS, 'checksums.sha256'].sort());
  assert.deepEqual(Object.keys(CSV_HEADERS).sort(), [...CSV_ARTIFACTS].sort());
});

test('checksum manifest parser: canonical, duplicate, malformed and empty input', () => {
  const manifest = parseChecksumManifest(`${'a'.repeat(64)}  companies.csv\n${'b'.repeat(64)}  snapshot.json\n`);
  assert.equal(manifest.size, 2);
  assert.equal(manifest.get('companies.csv'), 'a'.repeat(64));
  assert.equal(manifest.get('snapshot.json'), 'b'.repeat(64));
  assert.throws(() => parseChecksumManifest(`${'a'.repeat(64)}  companies.csv\n${'a'.repeat(64)}  companies.csv\n`));
  assert.throws(() => parseChecksumManifest(`zzz  companies.csv\n`));
  assert.throws(() => parseChecksumManifest(`${'a'.repeat(64)}   companies.csv\n`));
  assert.throws(() => parseChecksumManifest(`${'A'.repeat(64)}  companies.csv\n`));
  assert.throws(() => parseChecksumManifest(''));
});
