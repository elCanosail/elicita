/**
 * FARO — parseo RFC 4180 determinista y mapeadores de los artefactos del snapshot.
 *
 * Sin dependencias: campos entrecomillados (comas internas, comillas escapadas,
 * CRLF) se resuelven igual en cualquier entorno. Los mapeadores consumen
 * exactamente los artefactos validados por `validatePublishedMarketSnapshot`.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      pushField();
      i++;
      continue;
    }
    if (c === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i++;
      continue;
    }
    if (c === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Registros indexados por cabecera. */
export function csvToRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// ── Artefactos del snapshot ──

export interface YearPoint {
  year: string;
  amountEur: number;
  contracts: number;
  /** El año del corte (`period.to`) nunca está completo: se declara, no se oculta. */
  partial: boolean;
}

/**
 * Agrega las filas por empresa de evolution.csv en la serie anual.
 * Totales fuente-observados; el año del corte se marca como parcial.
 */
export function aggregateYearly(evolutionCsv: string, periodTo: string): YearPoint[] {
  const totals = new Map<string, { amount: number; contracts: number }>();
  for (const r of csvToRecords(evolutionCsv)) {
    const year = r['year'];
    const cur = totals.get(year) ?? { amount: 0, contracts: 0 };
    cur.amount += Number(r['observed_amount_eur']);
    cur.contracts += Number(r['analytic_contracts']);
    totals.set(year, cur);
  }
  const partialYear = periodTo.slice(0, 4);
  return [...totals.keys()].sort().map((year) => {
    const t = totals.get(year)!;
    return {
      year,
      amountEur: Math.round(t.amount * 100) / 100,
      contracts: t.contracts,
      partial: year === partialYear,
    };
  });
}

export interface ConcentrationRow {
  dimension: string;
  hhi: number;
  top1: number;
  top5: number;
  top10: number;
  /** Base del cálculo: el mercado resuelto (importe o contratos válidos). */
  denominator: number;
}

export function parseConcentration(concentrationCsv: string): ConcentrationRow[] {
  return csvToRecords(concentrationCsv).map((r) => ({
    dimension: r['dimension'],
    hhi: Number(r['hhi']),
    top1: Number(r['top1_share_pct']),
    top5: Number(r['top5_share_pct']),
    top10: Number(r['top10_share_pct']),
    denominator: Number(r['valid_denominator']),
  }));
}

export interface CompanyRow {
  rank: number;
  nif: string;
  name: string;
  contracts: number;
  amountEur: number;
  /** Cuota sobre el universo observado completo (base de companies.csv). */
  shareAmountPct: number;
  shareContractsPct: number;
}

export function parseCompanies(companiesCsv: string, limit = 7): CompanyRow[] {
  return csvToRecords(companiesCsv)
    .map((r) => ({
      rank: Number(r['rank']),
      nif: r['nif'],
      name: r['company_name'],
      contracts: Number(r['analytic_contracts']),
      amountEur: Number(r['observed_amount_eur']),
      shareAmountPct: Number(r['share_amount_pct']),
      shareContractsPct: Number(r['share_contracts_pct']),
    }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

export interface GroupRow {
  rank: number;
  groupId: string;
  name: string;
  companyCount: number;
  contracts: number;
  amountEur: number;
  shareAmountPct: number;
  shareContractsPct: number;
}

export function parseGroups(groupsCsv: string, limit = 5): GroupRow[] {
  return csvToRecords(groupsCsv)
    .map((r) => ({
      rank: Number(r['rank']),
      groupId: r['group_id'],
      name: r['group_name'],
      companyCount: Number(r['company_count']),
      contracts: Number(r['analytic_contracts']),
      amountEur: Number(r['observed_amount_eur']),
      shareAmountPct: Number(r['share_amount_pct']),
      shareContractsPct: Number(r['share_contracts_pct']),
    }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

export interface CoverageRow {
  metric: string;
  coveragePct: number;
  unknownCount: number;
  definition: string;
}

export function parseCoverage(coverageCsv: string): CoverageRow[] {
  return csvToRecords(coverageCsv).map((r) => ({
    metric: r['metric'],
    coveragePct: Number(r['coverage_pct']),
    unknownCount: Number(r['unknown_count']),
    definition: r['definition'],
  }));
}

export interface EdgeRow {
  rank: number;
  buyerId: string;
  buyerName: string;
  nif: string;
  companyName: string;
  contracts: number;
  amountEur: number;
}

/**
 * Pares comprador → adjudicataria de edges.csv (contrato v2). El CSV ya viene
 * ordenado por importe; aquí solo se tipa y recorta al límite pedido.
 */
export function parseEdges(edgesCsv: string, limit = 250): EdgeRow[] {
  return csvToRecords(edgesCsv)
    .map((r) => ({
      rank: Number(r['rank']),
      buyerId: r['buyer_id'] ?? '',
      buyerName: r['buyer_name'] ?? '',
      nif: r['nif'] ?? '',
      companyName: r['company_name'] ?? '',
      contracts: Number(r['analytic_contracts']),
      amountEur: Number(r['observed_amount_eur']),
    }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}
