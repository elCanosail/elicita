/**
 * Filtros del monitor (extraído verbatim de MonitorTable.astro 05-10-2026).
 * Normalización de estado de filtros → query del API y reglas de deduplicación.
 * Cero cambios de comportamiento respecto al inline original.
 */

export interface ImpRange {
  key: string;
  label: string;
  min: number;
  max: number;
}

export const IMP_RANGES: ImpRange[] = [
  { key: '0-50k', label: '< 50K €', min: 0, max: 50000 },
  { key: '50k-200k', label: '50K – 200K €', min: 50000, max: 200000 },
  { key: '200k-1m', label: '200K – 1M €', min: 200000, max: 1000000 },
  { key: '1m-5m', label: '1M – 5M €', min: 1000000, max: 5000000 },
  { key: '5m+', label: '> 5M €', min: 5000000, max: Infinity },
];

export function findImpRange(key: string): ImpRange | null {
  return IMP_RANGES.find((r) => r.key === key) || null;
}

export interface MonitorFilterState {
  /** activeFilters: chips {id, type, value, label} */
  filters: Array<{ id: number; type: string; value: string; label: string }>;
  selectedEstados: Set<string>;
  selectedFuentes: Set<string>;
  selectedCpvs: Set<string>;
  selectedImporte: ImpRange | null;
  sortCol: string;
  sortDir: number;
  /** Defaults server-side (dataset.estadosDefault del componente). */
  estadosDefault: string[];
  filterActivas: boolean;
  sortByAdj: boolean;
  showRelevance: boolean;
}

export function hasActiveFilters(state: {
  filters: unknown[];
  selectedEstados: Set<string>;
  selectedFuentes: Set<string>;
  selectedCpvs: Set<string>;
  selectedImporte: unknown;
}): boolean {
  return (
    state.filters.length > 0 ||
    state.selectedEstados.size > 0 ||
    state.selectedFuentes.size > 0 ||
    state.selectedCpvs.size > 0 ||
    state.selectedImporte != null
  );
}

export function isEstadoActive(estado: string, selected: Set<string>, defaults: string[]): boolean {
  return selected.size === 0 ? defaults.includes(estado) : selected.has(estado);
}

export function isDuplicateFilter(filters: Array<{ type: string; value: string }>, type: string, value: string): boolean {
  return filters.some((f) => f.type === type && f.value === value);
}

/** Siguiente id de filtro tras un restore: max(id)+1 sobre los chips guardados. */
export function nextFilterId(filters: Array<{ id?: number }>): number {
  return Math.max(...filters.map((x) => x.id || 0)) + 1;
}

/**
 * Query del API a partir del estado de filtros — port literal de buildApiUrl.
 * Devuelve los URLSearchParams (el llamador antepone '/api/data?').
 */
export function buildMonitorQuery(state: MonitorFilterState, page = 1): URLSearchParams {
  const params = new URLSearchParams();
  const textFilters = state.filters.filter((f) => f.type === 'text').map((f) => f.value);
  if (textFilters.length) params.set('q', textFilters.join(' '));
  const orgFilters = state.filters.filter((f) => f.type === 'org').map((f) => f.value);
  if (orgFilters.length) params.set('organismos', orgFilters.join(','));
  if (state.selectedCpvs.size > 0) params.set('cpvs', [...state.selectedCpvs].join(','));
  const estados = state.selectedEstados.size > 0 ? [...state.selectedEstados] : state.estadosDefault;
  params.set('estados', estados.join(','));
  if (state.filterActivas) params.set('activas', 'true');
  if (state.selectedFuentes.size > 0) params.set('fuentes', [...state.selectedFuentes].join(','));
  if (state.selectedImporte) {
    params.set('importe_min', String(state.selectedImporte.min));
    if (state.selectedImporte.max !== Infinity) params.set('importe_max', String(state.selectedImporte.max));
  }
  const sortMap: Record<string, string> = { fecha: 'fecha', importe: 'importe', objeto: 'objeto', organismo: 'organismo' };
  if (state.sortByAdj) sortMap.adjudicatario = 'adjudicatario';
  const effectiveSort =
    state.showRelevance && textFilters.length ? 'relevance' : sortMap[state.sortCol] || 'fecha';
  params.set('sort', effectiveSort);
  params.set('dir', state.sortDir > 0 ? 'asc' : 'desc');
  params.set('limit', '200');
  params.set('page', String(page));
  return params;
}

/** Forma persistida en localStorage (clave 'elicitamonitor-filters_v2'). */
export function serializeFilterState(state: {
  filters: unknown[];
  selectedEstados: Set<string>;
  selectedFuentes: Set<string>;
  selectedImporte: unknown;
  sortCol: string;
  sortDir: number;
}): string {
  return JSON.stringify({
    activeFilters: state.filters,
    selectedEstados: [...state.selectedEstados],
    selectedFuentes: [...state.selectedFuentes],
    selectedImporte: state.selectedImporte,
    sortCol: state.sortCol,
    sortDir: state.sortDir,
  });
}

/** Parse tolerante del estado guardado: null si falta o está corrupto. */
export function parseFilterState(raw: string | null): any | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
