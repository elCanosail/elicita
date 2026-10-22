import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderContextBars, renderHeroTotals, renderRankingTable, renderSeriesChart, renderShareBars } from '../faro/charts';
import { aggregateYearly, parseCompanies, parseConcentration, parseCoverage, parseCsv } from '../faro/csv';
import {
  escapeXml,
  formatDecimal,
  formatEurMillionValue,
  formatEurMillions,
  formatInt,
  formatPct,
  groupInteger,
} from '../faro/format';

const fixturesDir = fileURLToPath(new URL('../faro/__fixtures__/technology-20260915-153519Z', import.meta.url));
const goldenDir = fileURLToPath(new URL('../faro/__golden__', import.meta.url));
const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === '1';

const seriesFixture = JSON.parse(readFileSync(`${fixturesDir}/series.json`, 'utf8')) as {
  points: { year: string; amountEur: number; contracts: number; partial: boolean }[];
};
const companiesFixture = JSON.parse(readFileSync(`${fixturesDir}/companies.json`, 'utf8')) as {
  rows: { rank: number; nif: string; name: string; contracts: number; amountEur: number; shareAmountPct: number }[];
};
const concentrationFixture = JSON.parse(readFileSync(`${fixturesDir}/concentration.json`, 'utf8')) as {
  rows: { companies_amount: { hhi: number; top1: number; top5: number; top10: number; denominator: number } };
};

// Segunda serie para los tests de gráficos multi-serie y totales de la home.
const constructionPoints = [
  { year: '2022', amountEur: 12030000000, contracts: 38233, partial: false },
  { year: '2023', amountEur: 10344000000, contracts: 38794, partial: false },
  { year: '2024', amountEur: 11647000000, contracts: 43687, partial: false },
  { year: '2025', amountEur: 11572000000, contracts: 43940, partial: false },
  { year: '2026', amountEur: 227000000, contracts: 709, partial: true },
];

function golden(name: string, actual: string): void {
  if (UPDATE_GOLDENS) {
    writeFileSync(`${goldenDir}/${name}`, actual);
    return;
  }
  expect(actual).toBe(readFileSync(`${goldenDir}/${name}`, 'utf8'));
}

describe('renderContextBars (F4a — banda «En contexto»)', () => {
  it('salida byte-estable: tres sectores, uno activo', () => {
    golden(
      'contexto-f4a.html',
      renderContextBars([
        { label: 'Tecnología y telecomunicaciones', pct: 37.78, active: true },
        { label: 'Salud', pct: 26.98 },
        { label: 'Construcción y obra civil', pct: 14.47 },
      ]),
    );
  });
});

describe('formato determinista (sin Intl)', () => {
  it('agrupa miles con puntos', () => {
    expect(groupInteger(79681)).toBe('79.681');
    expect(groupInteger(16637)).toBe('16.637');
    expect(groupInteger(1000)).toBe('1.000');
    expect(groupInteger(999)).toBe('999');
    expect(groupInteger(1000000)).toBe('1.000.000');
  });

  it('formatEurMillions redondea al millón', () => {
    expect(formatEurMillions(16636971974.08)).toBe('16.637 M€');
    expect(formatEurMillions(997349626.1)).toBe('997 M€');
    expect(formatEurMillionValue(83176624.09)).toBe('83');
  });

  it('formatPct usa coma decimal', () => {
    expect(formatPct(8.40333)).toBe('8,4%');
    expect(formatPct(88.91831177, 2)).toBe('88,92%');
    expect(formatPct(0)).toBe('0,0%');
    expect(formatPct(7.33911446, 2)).toBe('7,34%');
  });

  it('formatDecimal agrupa miles y usa coma', () => {
    expect(formatDecimal(209.91567037)).toBe('209,9');
    expect(formatDecimal(14530.305056)).toBe('14.530,3');
  });

  it('formatInt agrupa contratos', () => {
    expect(formatInt(79681)).toBe('79.681');
  });

  it('escapeXml neutraliza markup', () => {
    expect(escapeXml('<b>"x" & \'y\'</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; &apos;y&apos;&lt;/b&gt;');
  });
});

describe('csv RFC 4180', () => {
  it('parsea comillas, comas internas, comillas escapadas y CRLF', () => {
    const rows = parseCsv('a,b,c\r\n"1,5","di""x""",3\n4,5,6');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1,5', 'di"x"', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('csvToRecords indexa por cabecera', () => {
    const recs = parseCsv('year,amount\n2022,100\n2023,200');
    expect(recs[1]).toEqual(['2022', '100']);
    expect(recs[2]).toEqual(['2023', '200']);
  });
});

describe('agregación de la serie anual', () => {
  it('agrega por año y marca el año de corte como parcial (caso manual verificado)', () => {
    const csv = [
      'year,entity_type,entity_id,entity_name,analytic_contracts,observed_amount_eur,share_amount_pct,share_contracts_pct',
      '2022,company,1,"Acme, S.L.",2,1000.50,0,0',
      '2022,company,2,Other,1,999.50,0,0',
      '2023,company,3,"Última, S.A.",3,2000.25,0,0',
    ].join('\n');
    expect(aggregateYearly(csv, '2023-06-15')).toEqual([
      { year: '2022', amountEur: 2000, contracts: 3, partial: false },
      { year: '2023', amountEur: 2000.25, contracts: 3, partial: true },
    ]);
  });
});

describe('golden charts (byte-estables)', () => {
  it('serie anual — SVG byte-estable', () => {
    golden('series-tecnologia.svg', renderSeriesChart(seriesFixture.points));
  });

  it('cuotas de concentración — SVG byte-estable', () => {
    const c = concentrationFixture.rows.companies_amount;
    golden(
      'concentracion-tecnologia.svg',
      renderShareBars([
        { label: 'Top 1', pct: c.top1 },
        { label: 'Top 5', pct: c.top5 },
        { label: 'Top 10', pct: c.top10 },
      ]),
    );
  });

  it('ranking de adjudicatarios — HTML byte-estable', () => {
    golden('ranking-tecnologia.html', renderRankingTable(companiesFixture.rows));
  });

  it('totales anuales de la home — SVG byte-estable', () => {
    const totals = seriesFixture.points.map((p, i) => ({
      ...p,
      amountEur: p.amountEur + constructionPoints[i].amountEur,
    }));
    golden('hero-totals-home.svg', renderHeroTotals(totals, { partialCut: '26 ene' }));
  });

  it('totales anuales — año parcial rayado en ámbar con nota de corte', () => {
    const totals = seriesFixture.points.map((p, i) => ({
      ...p,
      amountEur: p.amountEur + constructionPoints[i].amountEur,
    }));
    const svg = renderHeroTotals(totals, { partialCut: '26 ene' });
    expect(svg).toContain('<pattern id="faro-hatch-partial"');
    expect(svg).toContain('parcial — corte 26 ene');
    expect(svg).toContain('faro-chart-note');
    expect(svg).toMatch(/vs 2024</);
  });

  it('totales anuales — sin anotación con menos de dos años completos', () => {
    const svg = renderHeroTotals([
      { year: '2026', amountEur: 227000000, contracts: 709, partial: true },
    ]);
    expect(svg).not.toContain('faro-chart-note');
    expect(svg).toContain('parcial');
  });
});

describe('determinismo', () => {
  it('dos renders consecutivos son idénticos', () => {
    expect(renderSeriesChart(seriesFixture.points)).toBe(renderSeriesChart(seriesFixture.points));
    expect(renderRankingTable(companiesFixture.rows)).toBe(renderRankingTable(companiesFixture.rows));
    const totals = seriesFixture.points.map((p) => ({ ...p }));
    expect(renderHeroTotals(totals, { partialCut: '26 ene' })).toBe(
      renderHeroTotals(totals, { partialCut: '26 ene' }),
    );
  });

  it('el orden de entrada del ranking no altera la salida', () => {
    const reversed = [...companiesFixture.rows].reverse();
    expect(renderRankingTable(reversed)).toBe(renderRankingTable(companiesFixture.rows));
  });
});

describe('integración con el snapshot publicado', () => {
  const latestDir = `${process.cwd()}/public/data/market-intelligence/technology/latest`;
  const itIfPublished = existsSync(`${latestDir}/evolution.csv`) ? it : it.skip;

  itIfPublished('los artefactos reales reconcilian entre sí (firmeza)', () => {
    const evolution = readFileSync(`${latestDir}/evolution.csv`, 'utf8');
    const concentration = readFileSync(`${latestDir}/concentration.csv`, 'utf8');
    const companies = readFileSync(`${latestDir}/companies.csv`, 'utf8');
    const coverage = readFileSync(`${latestDir}/coverage.csv`, 'utf8');
    const snapshot = JSON.parse(readFileSync(`${latestDir}/snapshot.json`, 'utf8')) as {
      period: { to: string };
      metrics: { observed_amount_eur: number };
    };

    const points = aggregateYearly(evolution, snapshot.period.to);
    expect(points.length).toBeGreaterThanOrEqual(4);
    const resolvedTotal = points.reduce((s, p) => s + p.amountEur, 0);

    const amountRow = parseConcentration(concentration).find((c) => c.dimension === 'companies_amount');
    expect(amountRow).toBeDefined();
    // El agregado de evolution.csv reconcilia con la base resuelta de concentration.csv (< 1 M€).
    expect(Math.abs(resolvedTotal - amountRow!.denominator)).toBeLessThan(1_000_000);

    const top = parseCompanies(companies, 1)[0];
    // Cuota resuelta del líder ≈ top1_share_pct de concentration.csv (misma base: mercado resuelto).
    expect((top.amountEur / amountRow!.denominator) * 100).toBeCloseTo(amountRow!.top1, 2);
    // Cuota declarada en companies.csv ≈ importe / universo observado (base companies.csv).
    expect(top.shareAmountPct).toBeCloseTo((top.amountEur / snapshot.metrics.observed_amount_eur) * 100, 3);

    // La cobertura declara sus vacíos dentro de rango y con definición.
    for (const row of parseCoverage(coverage)) {
      expect(row.coveragePct).toBeGreaterThanOrEqual(0);
      expect(row.coveragePct).toBeLessThanOrEqual(100);
      expect(row.definition.length).toBeGreaterThan(0);
    }
  });
});
