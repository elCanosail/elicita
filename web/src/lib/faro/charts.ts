/**
 * FARO — render determinista snapshot → SVG/HTML en build.
 *
 * Cero JS runtime: la salida es byte-estable bajo golden tests. Los colores
 * referencian los tokens de DESIGN.FARO.md (con fallback literal); todo texto
 * interpolado se escapa; ningún formato depende de la ICU del entorno.
 */
import { titleCase } from '../format';
import type { CompanyRow, YearPoint } from './csv';
import { escapeXml, formatDecimal, formatEurMillionValue, formatEurMillions, formatInt, formatPct } from './format';

const EMERALD = 'var(--faro-emerald, oklch(0.72 0.15 162))';
const AMBER = 'var(--faro-amber, oklch(0.60 0.12 75))';
const LINE = 'var(--faro-line, oklch(0.86 0.012 160))';
const INK = 'var(--faro-ink, oklch(0.25 0.02 165))';
const INK_2 = 'var(--faro-ink-2, oklch(0.42 0.025 165))';
const INK_3 = 'var(--faro-ink-3, oklch(0.55 0.02 165))';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface SeriesChartOptions {
  width?: number;
  height?: number;
}

/**
 * Serie anual: barras desde cero, etiquetado directo, año parcial en ámbar
 * con nota explícita. La barra parcial nunca desaparece: altura mínima 3px.
 */
export function renderSeriesChart(points: YearPoint[], options: SeriesChartOptions = {}): string {
  const width = options.width ?? 960;
  const height = options.height ?? 285;
  const baseline = height - 53;
  const plotHeight = 170;
  const marginX = 30;
  const step = (width - marginX * 2) / points.length;
  const barWidth = Math.min(130, round2(step * 0.62));
  const maxAmount = Math.max(...points.map((p) => p.amountEur));
  const scale = plotHeight / maxAmount;

  const bars: string[] = [];
  const valueLabels: string[] = [];
  const yearLabels: string[] = [];

  points.forEach((p, i) => {
    const x = round2(marginX + step * i + (step - barWidth) / 2);
    const h = Math.max(3, round2(p.amountEur * scale));
    const y = round2(baseline - h);
    const cx = round2(x + barWidth / 2);
    bars.push(
      `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="${p.partial ? AMBER : EMERALD}" rx="1"/>`,
    );
    valueLabels.push(
      `<text class="faro-chart-val" x="${cx}" y="${round2(y - 9)}" text-anchor="middle" fill="${INK}">${formatEurMillionValue(p.amountEur)}</text>`,
    );
    yearLabels.push(
      `<text class="faro-chart-yr" x="${cx}" y="${baseline + 22}" text-anchor="middle" fill="${INK_3}">${p.year}</text>`,
    );
    if (p.partial) {
      yearLabels.push(
        `<text class="faro-chart-partial" x="${cx}" y="${baseline + 38}" text-anchor="middle" fill="${AMBER}">parcial</text>`,
      );
    }
  });

  const aria = `Importe anual resuelto en millones de euros: ${points
    .map((p) => `${p.year}, ${formatEurMillionValue(p.amountEur)}${p.partial ? ' (parcial)' : ''}`)
    .join('; ')}`;

  return [
    `<svg class="faro-series" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(aria)}" xmlns="http://www.w3.org/2000/svg">`,
    `<line x1="20" y1="${baseline}" x2="${width - 20}" y2="${baseline}" stroke="${LINE}" stroke-width="1"/>`,
    `<text class="faro-chart-yr" x="20" y="${baseline + 22}" fill="${INK_3}">M€</text>`,
    ...bars,
    ...valueLabels,
    ...yearLabels,
    '</svg>',
  ].join('');
}

export interface HeroTotalsOptions {
  width?: number;
  height?: number;
  /** Corte del año parcial, ya formateado (p. ej. "26 ene"); nota bajo el año. */
  partialCut?: string;
}

/**
 * Totales anuales del mercado resuelto para la home: una sola serie honesta
 * (suma de los sectores publicados en su ventana común), barras desde cero,
 * año parcial rayado en ámbar con corte real del dato, y anotación de
 * variación interanual sobre el último año completo. Determinista: misma
 * entrada, mismos bytes. La tabla accesible la monta el llamador.
 */
export function renderHeroTotals(points: YearPoint[], options: HeroTotalsOptions = {}): string {
  const width = options.width ?? 960;
  const height = options.height ?? 300;
  const top = 58;
  const baseline = height - 56;
  const plotHeight = baseline - top;
  const maxAmount = Math.max(...points.map((p) => p.amountEur));
  const scale = plotHeight / maxAmount;
  const step = (width - 60) / points.length;
  const barWidth = Math.min(120, round2(step * 0.42));

  const bars: string[] = [];
  const valueLabels: string[] = [];
  const yearLabels: string[] = [];
  const partialCut = options.partialCut ? escapeXml(options.partialCut) : '';

  points.forEach((p, i) => {
    const x = round2(30 + step * i + (step - barWidth) / 2);
    const h = Math.max(3, round2(p.amountEur * scale));
    const y = round2(baseline - h);
    const cx = round2(x + barWidth / 2);
    if (p.partial) {
      bars.push(
        `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="url(#faro-hatch-partial)" stroke="${AMBER}" stroke-width="1" rx="1"/>`,
      );
      yearLabels.push(
        `<text class="faro-chart-partial" x="${cx}" y="${baseline + 38}" text-anchor="middle" fill="${AMBER}">parcial${partialCut ? ` — corte ${partialCut}` : ''}</text>`,
      );
    } else {
      bars.push(`<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="${EMERALD}" rx="1"/>`);
    }
    valueLabels.push(
      `<text class="faro-chart-val" x="${cx}" y="${round2(y - 9)}" text-anchor="middle" fill="${INK}">${formatEurMillionValue(p.amountEur)}</text>`,
    );
    yearLabels.push(
      `<text class="faro-chart-yr" x="${cx}" y="${baseline + 22}" text-anchor="middle" fill="${INK_3}">${p.year}</text>`,
    );
  });

  // Variación interanual sobre el último año completo (2+ años completos).
  const full = points.filter((p) => !p.partial);
  if (full.length >= 2) {
    const [prev, last] = full.slice(-2);
    if (prev.amountEur > 0) {
      const growth = ((last.amountEur - prev.amountEur) / prev.amountEur) * 100;
      const sign = growth >= 0 ? '+' : '-';
      const lastFull = points.find((p) => p.year === last.year)!;
      const yBar = round2(baseline - Math.max(3, round2(lastFull.amountEur * scale)));
      const yAnn = Math.max(16, round2(yBar - 29));
      valueLabels.push(
        `<text class="faro-chart-note" x="${round2(30 + step * points.indexOf(lastFull) + (step - barWidth) / 2 + barWidth / 2)}" y="${yAnn}" text-anchor="middle" fill="var(--faro-civic, oklch(0.50 0.11 163))">${sign}${formatDecimal(Math.abs(growth), 1)}% vs ${prev.year}</text>`,
      );
    }
  }

  const aria = `Importe anual adjudicado a proveedores identificados, en millones de euros, suma de los sectores publicados: ${points
    .map((p) => `${p.year}, ${formatEurMillionValue(p.amountEur)}${p.partial ? ' (año parcial)' : ''}`)
    .join('; ')}`;

  return [
    `<svg class="faro-hero-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(aria)}" xmlns="http://www.w3.org/2000/svg">`,
    `<defs><pattern id="faro-hatch-partial" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="3.5" height="7" fill="${AMBER}"/><rect x="3.5" width="3.5" height="7" fill="none"/></pattern></defs>`,
    `<text class="faro-chart-yr" x="30" y="24" fill="${INK_3}">M€</text>`,
    `<line x1="30" y1="${baseline}" x2="${width - 30}" y2="${baseline}" stroke="${LINE}" stroke-width="1"/>`,
    ...bars,
    ...valueLabels,
    ...yearLabels,
    '</svg>',
  ].join('');
}

export interface ShareBarRow {
  label: string;
  pct: number;
}

export interface ShareBarsOptions {
  width?: number;
}

/** Cuotas acumuladas: barras horizontales proporcionalmente exactas (base = máx. de la serie). */
export function renderShareBars(rows: ShareBarRow[], options: ShareBarsOptions = {}): string {
  const width = options.width ?? 720;
  const rowHeight = 54;
  const height = rows.length * rowHeight;
  const maxPct = Math.max(...rows.map((r) => r.pct));
  const barX = 96;
  const barMaxWidth = width - barX - 116;
  const labelX = barX - 12;

  const out = rows
    .map((r, i) => {
      const yTop = i * rowHeight;
      const cy = round2(yTop + rowHeight / 2 + 5);
      const barY = yTop + rowHeight / 2 - 7;
      const w = round2((r.pct / maxPct) * barMaxWidth);
      return [
        `<text class="faro-share-label" x="${labelX}" y="${cy}" text-anchor="end" fill="${INK_2}">${escapeXml(r.label)}</text>`,
        `<rect x="${barX}" y="${round2(barY)}" width="${w}" height="14" fill="${EMERALD}" rx="1"/>`,
        `<text class="faro-share-val" x="${width - 8}" y="${cy}" text-anchor="end" fill="${INK}">${formatPct(r.pct, 1)}</text>`,
      ].join('');
    })
    .join('');

  const aria = rows.map((r) => `${r.label}: ${formatPct(r.pct, 1)}`).join('; ');
  return `<svg class="faro-shares" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(aria)}" xmlns="http://www.w3.org/2000/svg">${out}</svg>`;
}

export interface ContextBarRow {
  label: string;
  pct: number;
  active?: boolean;
}

/**
 * Banda «En contexto» (F4a): comparación de una misma métrica entre los
 * sectores publicados. HTML plano, escala por anchura relativa a la mayor.
 * Determinista: sin Intl, sin Date, entrada ordenada por el llamador.
 */
export function renderContextBars(rows: ContextBarRow[]): string {
  const maxPct = Math.max(...rows.map((r) => r.pct));
  const out = rows
    .map((r) => {
      const width = round2((r.pct / maxPct) * 100);
      const cls = r.active ? 'faro-ctx-row faro-ctx-row--active' : 'faro-ctx-row';
      return [
        `<div class="${cls}">`,
        `<span class="faro-ctx-label">${escapeXml(r.label)}</span>`,
        `<span class="faro-ctx-track"><span class="faro-ctx-fill" style="width:${width}%"></span></span>`,
        `<span class="faro-ctx-val faro-mono">${formatPct(r.pct, 1)}</span>`,
        '</div>',
      ].join('');
    })
    .join('');
  const aria = rows.map((r) => `${r.label}: ${formatPct(r.pct, 1)}`).join('; ');
  return `<div class="faro-ctx" role="img" aria-label="${escapeXml(aria)}">${out}</div>`;
}

/**
 * Tabla editorial de adjudicatarios: posición, nombre (title-case del nombre
 * fuente-observado), NIF, barra proporcional, importe y cuota. La cuota se
 * refiere al universo observado completo, como declara companies.csv.
 */
export function renderRankingTable(rows: CompanyRow[]): string {
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  const maxShare = Math.max(...sorted.map((r) => r.shareAmountPct));

  const body = sorted
    .map((r) => {
      const barWidth = round2((r.shareAmountPct / maxShare) * 100);
      return [
        '<tr>',
        `<td class="faro-rank-pos">${r.rank}</td>`,
        `<td class="faro-rank-co"><div class="faro-rank-name">${escapeXml(titleCase(r.name))}</div><div class="faro-rank-nif">${escapeXml(r.nif)}</div><div class="faro-rank-bar" style="width:${barWidth}%"></div></td>`,
        `<td class="faro-rank-contracts">${formatInt(r.contracts)}</td>`,
        `<td class="faro-rank-amount"><span class="faro-rank-big">${formatEurMillions(r.amountEur)}</span><br><span class="faro-rank-sub">${formatPct(r.shareAmountPct, 2)}</span></td>`,
        '</tr>',
      ].join('');
    })
    .join('');

  return [
    '<table class="faro-rank">',
    '<thead><tr><th scope="col">#</th><th scope="col">Empresa</th><th scope="col">Contratos</th><th scope="col" class="faro-r">Importe</th></tr></thead>',
    `<tbody>${body}</tbody>`,
    '</table>',
  ].join('\n');
}
