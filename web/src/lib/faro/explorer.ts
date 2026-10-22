/**
 * FARO — lógica pura de la isla exploradora (F4a): búsqueda, orden y
 * paginación sobre el artefacto companies.csv completo. Sin DOM aquí — el
 * script de la ficha hace el pegamento; las pruebas unitarias cubren esta
 * lógica. Reutiliza los formateadores deterministas de format.ts.
 */
import { parseCompanies, type CompanyRow } from './csv';
import { escapeXml, formatEurMillions, formatInt, formatPct } from './format';
import { titleCase } from '../format';

export type ExplorerSortKey = 'rank' | 'amount' | 'contracts' | 'share';

/** companies.csv completo → filas tipadas, sin límite de ranking. */
export function parseExplorerRows(companiesCsv: string): CompanyRow[] {
  return parseCompanies(companiesCsv, Number.MAX_SAFE_INTEGER);
}

const normalize = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Subcadena insensible a acentos y mayúsculas sobre nombre o NIF. */
export function filterCompanies(rows: CompanyRow[], query: string): CompanyRow[] {
  const q = normalize(query.trim());
  if (!q) return rows;
  return rows.filter((r) => normalize(r.name).includes(q) || r.nif.toLowerCase().includes(q));
}

/** Orden descendente por métrica; 'rank' restaura el orden editorial. */
export function sortCompanies(rows: CompanyRow[], key: ExplorerSortKey): CompanyRow[] {
  const sorted = [...rows];
  if (key === 'rank') return sorted.sort((a, b) => a.rank - b.rank);
  const pick = (r: CompanyRow): number =>
    key === 'amount' ? r.amountEur : key === 'contracts' ? r.contracts : r.shareAmountPct;
  return sorted.sort((a, b) => pick(b) - pick(a));
}

/** Fila de tabla con la misma estructura que renderRankingTable (charts.ts). */
export function explorerRowHtml(row: CompanyRow, maxShare: number): string {
  const barWidth = maxShare > 0 ? Math.round((row.shareAmountPct / maxShare) * 100) : 0;
  return [
    '<tr>',
    `<td class="faro-rank-pos">${row.rank}</td>`,
    `<td class="faro-rank-co"><div class="faro-rank-name">${escapeXml(titleCase(row.name))}</div><div class="faro-rank-nif">${escapeXml(row.nif)}</div><div class="faro-rank-bar" style="width:${barWidth}%"></div></td>`,
    `<td class="faro-rank-contracts">${formatInt(row.contracts)}</td>`,
    `<td class="faro-rank-amount"><span class="faro-rank-big">${formatEurMillions(row.amountEur)}</span><br><span class="faro-rank-sub">${formatPct(row.shareAmountPct, 2)}</span></td>`,
    '</tr>',
  ].join('');
}
