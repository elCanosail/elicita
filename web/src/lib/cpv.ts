/**
 * cpv.ts — Normalización de códigos CPV compartida.
 *
 * La forma canónica es dígitos sin puntos ni ceros finales, usada como
 * PREFIJO en los filtros SQL (LIKE '3314%') para capturar toda la familia
 * del CPV (división/capítulo → clase → subcódigos).
 */

/**
 * Normaliza un código CPV a su forma canónica (dígitos sin puntos ni ceros
 * finales) para matching por PREFIJO: "33140000" → "3314", "3314.00.00" →
 * "3314", "33140000.0" → "3314". Los ceros finales NO se pueden recuperar
 * (la forma canónica es de longitud variable) — por eso el JSDoc anterior,
 * que decía "33140000" → "33140000", describía un contrato imposible.
 * Devuelve null si la entrada no es válida.
 */
export function normalizeCpv(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const withoutDots = raw.trim().replace(/\./g, '');
  if (!/^\d+$/.test(withoutDots)) return null;
  // Quitar ceros finales manteniendo al menos un dígito.
  return withoutDots.replace(/0+$/, '') || null;
}
