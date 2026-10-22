import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = content => createHash('sha256').update(content).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

const files = {
  'companies.csv': [
    'rank,nif,company_name,analytic_contracts,observed_amount_eur,share_amount_pct,share_contracts_pct,group_id,group_name',
    '1,B00000001,Fixture Systems SA,3,400000,40,37.5,g-fixture,Grupo Fixture',
    '2,B00000002,Fixture Networks SL,2,200000,20,25,,',
  ].join('\n') + '\n',
  'business-groups.csv': [
    'rank,group_id,group_name,company_count,analytic_contracts,observed_amount_eur,share_amount_pct,share_contracts_pct',
    '1,g-fixture,Grupo Fixture,1,3,400000,40,37.5',
  ].join('\n') + '\n',
  'buyers.csv': [
    'rank,buyer_id,buyer_name,analytic_contracts,observed_amount_eur,share_market_amount_pct',
    '1,buyer-fixture-1,Comprador Fixture Uno,4,500000,50',
    '2,buyer-fixture-2,Comprador Fixture Dos,2,250000,25',
  ].join('\n') + '\n',
  'concentration.csv': [
    'period,dimension,hhi,top1_share_pct,top5_share_pct,top10_share_pct,valid_denominator',
    '2022-01-01/2026-09-14,companies_amount,2000,40,80,80,1000000',
    '2022-01-01/2026-09-14,companies_contracts,1953.125,37.5,75,75,8',
  ].join('\n') + '\n',
  'evolution.csv': [
    'year,entity_type,entity_id,entity_name,analytic_contracts,observed_amount_eur,share_amount_pct,share_contracts_pct',
    '2026,company,B00000001,Fixture Systems SA,3,400000,40,37.5',
  ].join('\n') + '\n',
  'coverage.csv': [
    'metric,numerator,denominator,coverage_pct,unknown_count,definition',
    'cpv_resolved_pct,8,8,100,0,CPV resuelto por taxonomía versionada.',
    'amount_valid_pct,950000,1000000,95,1,Importe finito y no negativo del universo publicado.',
    'supplier_nif_valid_pct,6,8,75,2,NIF con forma válida entre contratos analíticos.',
    'supplier_resolved_pct,5,8,62.5,3,Adjudicatario resuelto con evidencia suficiente.',
    'business_group_resolved_pct,4,8,50,4,Grupo curado y vigente para la sociedad.',
    'buyer_resolved_pct,7,8,87.5,1,Comprador con identificador canónico versionado.',
    'ute_unresolved_amount_pct,100000,1000000,10,1,Importe retenido en UTE sin reparto oficial.',
  ].join('\n') + '\n',
  'exclusions.csv': [
    'reason_code,reason_label,rows,amount_eur,share_source_rows_pct',
    'fixture_exclusion,Exclusión sintética de fixture,2,50000,16.6666666667',
  ].join('\n') + '\n',
  'methodology.json': json({
    fixture: true,
    purpose: 'Synthetic test artifact only; not market data.',
    methodology_version: '1.0.0',
  }),
};

const snapshot = {
  schema: 'elicita.market-intelligence/v1',
  snapshot_id: 'technology-20260914-220000Z',
  dataset: 'technology',
  title: 'Fixture de contrato Market Intelligence',
  generated_at: '2026-09-14T22:00:00Z',
  period: { from: '2022-01-01', to: '2026-09-14' },
  source: { name: 'Synthetic fixture only', freshness_date: '2026-09-14', fingerprint: `sha256:${'a'.repeat(64)}` },
  methodology: {
    schema_version: '1', methodology_version: '1.0.0', taxonomy_version: '1.0.0', identity_registry_version: '1.0.0',
  },
  universe: { source_rows: 12, sector_candidates: 10, analytic_contracts: 8, excluded_rows: 2 },
  coverage: {
    cpv_resolved_pct: 100, amount_valid_pct: 95, supplier_nif_valid_pct: 75, supplier_resolved_pct: 62.5,
    business_group_resolved_pct: 50, buyer_resolved_pct: 87.5, ute_unresolved_amount_pct: 10,
  },
  metrics: { observed_amount_eur: 1000000, companies: 2, business_groups: 1, buyers: 2, hhi_amount: 2000, hhi_contracts: 1953.125 },
  downloads: {
    companies_csv: 'companies.csv', business_groups_csv: 'business-groups.csv', buyers_csv: 'buyers.csv',
    concentration_csv: 'concentration.csv', evolution_csv: 'evolution.csv', coverage_csv: 'coverage.csv', exclusions_csv: 'exclusions.csv',
  },
  limitations: [
    'Fixture sintético para pruebas; no representa el mercado ni producción.',
    'El importe observado no equivale a gasto ejecutado.',
  ],
  license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  receipt: 'generation-receipt.json',
};

export async function writeFixture(directory) {
  await mkdir(directory, { recursive: true });
  const output = { 'snapshot.json': json(snapshot), ...files };
  const receipt = {
    schema: 'elicita.generation-receipt/v1',
    snapshot_id: snapshot.snapshot_id,
    generated_at: snapshot.generated_at,
    pipeline_commit: 'b'.repeat(40),
    working_tree_clean: true,
    source_fingerprint: snapshot.source.fingerprint,
    taxonomy_hash: `sha256:${'c'.repeat(64)}`,
    identity_registry_hash: `sha256:${'d'.repeat(64)}`,
    query_hash: `sha256:${'e'.repeat(64)}`,
    outputs: Object.fromEntries(Object.entries(output).map(([name, content]) => [name, `sha256:${hash(content)}`])),
    checks: {
      schema_valid: true, duplicate_analytic_ids: 0, shares_within_tolerance: true, rankings_deterministic: true,
      no_direct_identifiers: true, minimum_group_policy_applied: true, freshness_non_regression: true,
    },
  };
  output['generation-receipt.json'] = json(receipt);
  output['checksums.sha256'] = Object.entries(output)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, content]) => `${hash(content)}  ${name}`)
    .join('\n') + '\n';

  await Promise.all(Object.entries(output).map(([name, content]) => writeFile(resolve(directory, name), content, 'utf8')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2] ? resolve(process.argv[2]) : dirname(fileURLToPath(import.meta.url));
  await writeFixture(target);
}
