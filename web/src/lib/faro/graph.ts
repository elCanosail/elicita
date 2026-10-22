/**
 * FARO — grafo bipartito comprador → adjudicataria, render determinista en build.
 *
 * Entrada: edges.csv del snapshot (pares ya ordenados por importe). Cero JS
 * runtime: SVG byte-estable, sin física ni aleatoriedad. El layout reparte las
 * dos columnas uniformemente y conecta con curvas cuyo grosor sigue el importe;
 * los empates de lectura se resuelven por el orden del CSV (determinista).
 */
import type { EdgeRow } from './csv';
import { escapeXml, formatEurMillions, formatInt } from './format';

const EMERALD = 'var(--faro-emerald, oklch(0.72 0.15 162))';
const INK = 'var(--faro-ink, oklch(0.25 0.02 165))';
const INK_3 = 'var(--faro-ink-3, oklch(0.55 0.02 165))';
const LINE = 'var(--faro-line, oklch(0.86 0.012 160))';

export interface BipartiteEdgesOptions {
  /** Máximo de pares dibujados (el CSV ya viene ordenado por importe). */
  limit?: number;
  width?: number;
}

const MAX_LABEL_CHARS = 42;
const ROW_HEIGHT = 24;
const PADDING_TOP = 26;
const PADDING_BOTTOM = 6;
const LEFT_LABEL_X = 330;
const RIGHT_LABEL_X = 590;
const EDGE_X1 = 336;
const EDGE_X2 = 584;

const truncate = (label: string): string =>
  label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;

/**
 * Grafo bipartito: compradores a la izquierda, adjudicatarias a la derecha,
 * una curva por par. Columnas distribuidas uniformemente sobre la misma
 * altura interior; grosor de curva = importe del par escalado al máximo.
 */
export function renderBipartiteEdges(edges: readonly EdgeRow[], options: BipartiteEdgesOptions = {}): string {
  const limit = options.limit ?? 24;
  const width = options.width ?? 920;
  const pairs = edges.slice(0, limit);
  if (pairs.length === 0) return '';

  const buyers: { id: string; name: string }[] = [];
  const companies: { nif: string; name: string }[] = [];
  const buyerIndex = new Map<string, number>();
  const companyIndex = new Map<string, number>();
  for (const pair of pairs) {
    if (!buyerIndex.has(pair.buyerId)) {
      buyerIndex.set(pair.buyerId, buyers.length);
      buyers.push({ id: pair.buyerId, name: pair.buyerName });
    }
    if (!companyIndex.has(pair.nif)) {
      companyIndex.set(pair.nif, companies.length);
      companies.push({ nif: pair.nif, name: pair.companyName });
    }
  }

  const maxAmount = Math.max(...pairs.map((p) => p.amountEur));
  const innerHeight = Math.max(buyers.length, companies.length) * ROW_HEIGHT;
  const height = PADDING_TOP + innerHeight + PADDING_BOTTOM;
  const spread = (count: number, index: number): number =>
    PADDING_TOP + (innerHeight * (index + 0.5)) / count;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Grafo bipartito de relaciones comprador-adjudicataria del sector">`,
  );

  parts.push(
    `<text x="${LEFT_LABEL_X}" y="16" text-anchor="end" font-size="11" fill="${INK_3}">COMPRADOR</text>`,
    `<text x="${RIGHT_LABEL_X}" y="16" text-anchor="start" font-size="11" fill="${INK_3}">ADJUDICATARIA</text>`,
    `<line x1="${EDGE_X1}" y1="${PADDING_TOP}" x2="${EDGE_X1}" y2="${PADDING_TOP + innerHeight}" stroke="${LINE}" stroke-width="1"/>`,
    `<line x1="${EDGE_X2}" y1="${PADDING_TOP}" x2="${EDGE_X2}" y2="${PADDING_TOP + innerHeight}" stroke="${LINE}" stroke-width="1"/>`,
  );

  for (const pair of pairs) {
    const buyerY = spread(buyers.length, buyerIndex.get(pair.buyerId)!);
    const companyY = spread(companies.length, companyIndex.get(pair.nif)!);
    const midX = (EDGE_X1 + EDGE_X2) / 2;
    const strokeWidth = Math.round((0.75 + 5.25 * (pair.amountEur / maxAmount)) * 100) / 100;
    parts.push(
      `<path d="M ${EDGE_X1} ${buyerY} C ${midX} ${buyerY}, ${midX} ${companyY}, ${EDGE_X2} ${companyY}" fill="none" stroke="${EMERALD}" stroke-width="${strokeWidth}" stroke-opacity="0.55"><title>${escapeXml(pair.buyerName)} ↔ ${escapeXml(pair.companyName)} · ${escapeXml(formatEurMillions(pair.amountEur))} · ${escapeXml(formatInt(pair.contracts))} contratos</title></path>`,
    );
  }

  buyers.forEach((buyer, index) => {
    parts.push(
      `<text x="${LEFT_LABEL_X}" y="${(spread(buyers.length, index) + 4).toFixed(1)}" text-anchor="end" font-size="12.5" fill="${INK}"><title>${escapeXml(buyer.name)}</title>${escapeXml(truncate(buyer.name))}</text>`,
    );
  });
  companies.forEach((company, index) => {
    parts.push(
      `<text x="${RIGHT_LABEL_X}" y="${(spread(companies.length, index) + 4).toFixed(1)}" text-anchor="start" font-size="12.5" fill="${INK}"><title>${escapeXml(company.name)}</title>${escapeXml(truncate(company.name))}</text>`,
    );
  });

  parts.push('</svg>');
  return parts.join('');
}
