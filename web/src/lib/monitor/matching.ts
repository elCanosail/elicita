/**
 * Matching de autocompletado del monitor (extraído verbatim de MonitorTable.astro 05-10-2026).
 * El llamador pre-lowercasea la query (`q = input.value.trim().toLowerCase()`).
 */

/** Opciones del dropdown CPV: descripción contiene q o código empieza por q, excluye ya seleccionados, tope 15. */
export function matchCpvDropdown(
  cpvDict: Record<string, string>,
  q: string,
  selectedCpvs: Set<string>,
  limit = 15,
): Array<[string, string]> {
  return Object.entries(cpvDict)
    .filter(([code, desc]) => desc.toLowerCase().includes(q) || code.startsWith(q))
    .filter(([code]) => !selectedCpvs.has(code.slice(0, 5)))
    .slice(0, limit);
}

export interface AutocompleteMatches {
  orgs: Array<{ nombre: string; count?: number }>;
  cpvs: Array<{ code: string; desc: string }>;
}

/** Matching del buscador principal: 5 organismos + 7 CPVs, descripción sin punto final. */
export function matchAutocomplete(
  allOrgs: Array<{ nombre: string; count?: number }>,
  cpvDict: Record<string, string>,
  q: string,
): AutocompleteMatches {
  const orgMatches = allOrgs.filter((o) => o.nombre.toLowerCase().includes(q)).slice(0, 5);
  const cpvMatches = Object.entries(cpvDict)
    .filter(([_, desc]) => desc.toLowerCase().includes(q))
    .slice(0, 7)
    .map(([code, desc]) => ({ code, desc: desc.replace(/\.$/, '') }));
  return { orgs: orgMatches, cpvs: cpvMatches };
}

/** Etiqueta de chip CPV: dict[code] con fallbacks code+000/code+00/code, sin punto final, máx 30 chars. */
export function cpvLabel(cpvDict: Record<string, unknown>, code: string): string {
  const desc = cpvDict[code] || cpvDict[code + '000'] || cpvDict[code + '00'] || code;
  return ((typeof desc === 'string' ? desc.replace(/\.$/, '') : code) as string).substring(0, 30);
}
