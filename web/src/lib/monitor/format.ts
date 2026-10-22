/**
 * Formato del monitor (extraído verbatim de MonitorTable.astro 05-10-2026).
 * Funciones puras de escapado/normalización — cero cambios de comportamiento.
 */

/** Escape HTML para atributos y texto: & < > " (en ese orden; s falsy → ''). */
export function esc(s: unknown): string {
  return String((s as any) || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** CPV normalizado: quita sufijo decimal ".0" y dígito de control "-N", recorta espacios. */
export function normCpv(r: unknown): string {
  return r ? r.toString().replace(/\.0$/, '').replace(/-\d$/, '').trim() : '';
}

/**
 * Fecha publicada en formato es-ES (día 2 dígitos, mes corto, año).
 * Solo reformatea fechas que empiezan por AAAA-MM; el resto pasa tal cual.
 */
export function fmtFecha(s: unknown): string {
  const str = s as string;
  if (!str) return '';
  if (/^\d{4}-\d{2}/.test(str)) {
    try {
      return new Date(str + 'T12:00:00Z').toLocaleDateString('es-ES', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return str;
    }
  }
  return str;
}

/** Conteo de columnas de la tabla: 4 base + adjudicatario + fuente según modo. */
export function getColCount(showAdj: boolean, showFuente: boolean): number {
  return 4 + (showAdj ? 1 : 0) + (showFuente ? 1 : 0);
}
