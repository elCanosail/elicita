/**
 * FARO — formato determinista, sin Intl.
 *
 * Intl.NumberFormat depende de la ICU del entorno; los golden tests exigen
 * salida byte-estable en cualquier máquina. Convenciones españolas fijas:
 * miles con punto, decimales con coma.
 */

/** 16637 → "16.637" · 999 → "999" · 1000000 → "1.000.000" */
export function groupInteger(n: number): string {
  const s = Math.abs(n).toFixed(0);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '.';
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
}

/** 16636971974.08 → "16.637" (millones, redondeo al más cercano). */
export function formatEurMillionValue(eur: number): string {
  return groupInteger(Math.round(eur / 1e6));
}

/** 16636971974.08 → "16.637 M€" */
export function formatEurMillions(eur: number): string {
  return `${formatEurMillionValue(eur)} M€`;
}

/** 79681 → "79.681" */
export function formatInt(n: number): string {
  return groupInteger(n);
}

/** 209.91567 → "209,9" · 14530.3 → "14.530,3" — coma decimal, miles agrupados. */
export function formatDecimal(n: number, decimals = 1): string {
  const fixed = n.toFixed(decimals);
  const [int, dec] = fixed.split('.');
  return `${groupInteger(Number(int))},${dec}`;
}

/** 8.40333 → "8,4%" · 88.91831 con 2 → "88,92%" */
export function formatPct(p: number, decimals = 1): string {
  return `${formatDecimal(p, decimals)}%`;
}

/** Neutraliza markup en texto interpolado a SVG/HTML. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
