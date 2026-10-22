/**
 * Title-case a company name, keeping legal suffixes uppercase
 * and Spanish connectors lowercase.
 */
export function titleCase(s: string | null | undefined): string {
  if (!s) return '';
  const lowerSet = new Set(['y', 'e', 'de', 'del', 'la', 'las', 'los', 'el', 'en', 'con', 'para', 'por']);
  return s.split(/(\s+|,\s*)/).map((word, i) => {
    if (/^(S\.?L\.?U?\.?|S\.?A\.?U?\.?|S\.?C\.?|S\.?L\.?P\.?|U\.?T\.?E\.?|A\.?I\.?E\.?)$/i.test(word))
      return word.toUpperCase();
    if (/^\s+$/.test(word) || /^,/.test(word)) return word;
    const w = word.toLowerCase();
    if (i > 0 && lowerSet.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}

/**
 * Formato español de importes.
 *   < 1.000      → "890 €"
 *   1K-999K      → "45.890 €"
 *   1M-999M      → "2,3 M€"
 *   ≥ 1.000M     → "1.450 M€"
 */
export function fmtVolumen(v: number): string {
  const es = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
  if (v >= 1e9) return es.format(v / 1e6) + ' M€';
  if (v >= 1e6) return es.format(v / 1e6) + ' M€';
  if (v >= 1e3) return es.format(v) + ' €';
  return es.format(v) + ' €';
}

/**
 * Formato corto de importes para KPIs y badges.
 *   890        → "890 €"
 *   45890      → "45,9 K€"
 *   2300000    → "2,3 M€"
 */
export function fmtVol(v: number): string {
  const es = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
  if (v >= 1e6) return es.format(v / 1e6) + ' M€';
  if (v >= 1e3) return es.format(v / 1e3) + ' K€';
  return es.format(v) + ' €';
}

/**
 * Formato de fecha en español.
 *   corto:  "15 ene 2023"
 *   largo:  "15 de enero de 2023"
 *   iso:    "2023-01-15"
 */
export function fmtDate(d: string | Date | null | undefined, mode: 'corto' | 'largo' | 'iso' = 'corto'): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return '—';
  const mesesCorto = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const mesesLargo = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  if (mode === 'iso') return date.toISOString().slice(0, 10);
  if (mode === 'largo') return `${date.getDate()} de ${mesesLargo[date.getMonth()]} de ${date.getFullYear()}`;
  return `${date.getDate()} ${mesesCorto[date.getMonth()]} ${date.getFullYear()}`;
}
