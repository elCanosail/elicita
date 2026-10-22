import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  buildDuckDbProjection,
  deriveObservedIdentityRegistry,
  generateTechnologyCandidate,
  loadOpenDataFixture,
  readCanonicalRowsFromDuckDb,
  TECHNOLOGY_DUCKDB_PROJECTION,
} from '../src/lib/open-data-generator.js';
import { mergeCuratedGroups } from '../src/lib/curated-groups.js';
import { constructionProductionTaxonomy, defensaProductionTaxonomy, energiaProductionTaxonomy, limpiezaProductionTaxonomy, saludProductionTaxonomy, technologyFixtureRows, technologyIdentityRegistry, technologyProductionTaxonomy, technologyTaxonomy, transporteProductionTaxonomy } from '../src/lib/open-data-fixture.js';
import { constructionRecordExclusions } from '../src/lib/open-data-record-exclusions.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = argument(name);
  if (value === undefined || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

function git(command: string[]): string {
  return execFileSync('git', command, { encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  const outputDir = resolve(required('--output'));
  const generatedAt = required('--generated-at');
  const snapshotId = required('--snapshot-id');
  const fixturePath = argument('--fixture');
  const duckdbPath = argument('--duckdb');
  const dataset = argument('--dataset') ?? 'technology';
  if (dataset !== 'technology' && dataset !== 'construction' && dataset !== 'salud' && dataset !== 'energia' && dataset !== 'limpieza' && dataset !== 'defensa' && dataset !== 'transporte') throw new Error(`unknown --dataset: ${dataset}`);
  const productionTaxonomy = dataset === 'construction' ? constructionProductionTaxonomy : dataset === 'salud' ? saludProductionTaxonomy : dataset === 'energia' ? energiaProductionTaxonomy : dataset === 'limpieza' ? limpiezaProductionTaxonomy : dataset === 'defensa' ? defensaProductionTaxonomy : dataset === 'transporte' ? transporteProductionTaxonomy : technologyProductionTaxonomy;
  const productionProjection = dataset === 'construction' ? buildDuckDbProjection(['45'], '2026-09-14') : dataset === 'salud' ? buildDuckDbProjection(['33', '85'], '2026-09-14') : dataset === 'energia' ? buildDuckDbProjection(['31', '65'], '2026-09-14') : dataset === 'limpieza' ? buildDuckDbProjection(['90'], '2026-09-14') : dataset === 'defensa' ? buildDuckDbProjection(['35'], '2026-09-14') : dataset === 'transporte' ? buildDuckDbProjection(['60'], '2026-09-14') : TECHNOLOGY_DUCKDB_PROJECTION;
  if ((fixturePath === undefined) === (duckdbPath === undefined)) throw new Error('supply exactly one of --fixture or --duckdb');
  if (duckdbPath !== undefined && required('--taxonomy-version') !== productionTaxonomy.version) {
    throw new Error(`--taxonomy-version must be ${productionTaxonomy.version} for this production query`);
  }
  if (outputDir.includes('/web/public/')) throw new Error('candidate output must not be under web/public; promotion is a separate reviewed action');
  if (git(['status', '--porcelain']) !== '') throw new Error('refusing candidate generation from a dirty pipeline tree');
  const defaults = { taxonomy: technologyTaxonomy, identityRegistry: technologyIdentityRegistry };
  const source = fixturePath === undefined
    ? { rows: await readCanonicalRowsFromDuckDb({ databasePath: resolve(duckdbPath as string), query: productionProjection }), sourceName: 'Elicita calidad histórica, última revisión por id (DuckDB read-only)' }
    : { ...(await loadOpenDataFixture(resolve(fixturePath))), sourceName: `fixture:${resolve(fixturePath).split('/').pop()}` };
  const rows = source.rows ?? technologyFixtureRows;
  const taxonomy = source.taxonomy ?? (duckdbPath === undefined ? defaults.taxonomy : productionTaxonomy);
  const identityRegistry = source.identityRegistry ?? (duckdbPath === undefined
    ? defaults.identityRegistry
    : mergeCuratedGroups(deriveObservedIdentityRegistry(rows, generatedAt.slice(0, 10))));
  const result = await generateTechnologyCandidate({
    outputDir,
    rows,
    taxonomy,
    identityRegistry,
    generatedAt,
    snapshotId,
    pipelineCommit: git(['rev-parse', 'HEAD']),
    sourceName: source.sourceName,
    queryContract: duckdbPath === undefined ? undefined : productionProjection,
    workingTreeClean: true,
    datasetId: dataset,
    datasetTitle: dataset === 'construction' ? 'Construcción' : dataset === 'salud' ? 'Salud' : undefined,
    recordExclusions: dataset === 'construction' ? constructionRecordExclusions : undefined,
  });
  process.stdout.write(`${JSON.stringify({ outputDir: result.outputDir, artifacts: result.artifacts, checksums: result.checksums }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
