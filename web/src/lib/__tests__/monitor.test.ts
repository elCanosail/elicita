/**
 * Tests de caracterización de la lógica extraída del monitor (MonitorTable.astro).
 * Fijan el comportamiento ACTUAL antes del refactor inline→import: si algún
 * caso sorprende, es un bug documentado — no un requisito nuevo.
 */
import { describe, expect, it } from 'vitest';
import { esc, normCpv, fmtFecha, getColCount } from '../monitor/format';
import {
  IMP_RANGES,
  findImpRange,
  hasActiveFilters,
  isEstadoActive,
  isDuplicateFilter,
  nextFilterId,
  buildMonitorQuery,
  serializeFilterState,
  parseFilterState,
} from '../monitor/filters';
import { matchCpvDropdown, matchAutocomplete, cpvLabel } from '../monitor/matching';
import { nextSortState } from '../monitor/sort';

describe('format — esc/normCpv/fmtFecha/columnas', () => {
  it('esc escapa & < > " en ese orden', () => {
    expect(esc('a<b>"&')).toBe('a&lt;b&gt;&quot;&amp;');
  });

  it('esc de falsy (null, 0) devuelve cadena vacía', () => {
    expect(esc(null)).toBe('');
    expect(esc(0)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('normCpv quita sufijo decimal .0 y dígito de control -N, y recorta', () => {
    expect(normCpv('71310000.0')).toBe('71310000');
    expect(normCpv('71310000-1')).toBe('71310000');
    expect(normCpv(' 033 ')).toBe('033');
    expect(normCpv(null)).toBe('');
    expect(normCpv('')).toBe('');
  });

  it('fmtFecha: vacío → ""; no-fecha pasa tal cual; fecha ISO se formatea es-ES', () => {
    expect(fmtFecha('')).toBe('');
    expect(fmtFecha(null)).toBe('');
    expect(fmtFecha('sin formato')).toBe('sin formato');
    const out = fmtFecha('2026-10-01');
    expect(out).toMatch(/01/);
    expect(out).toMatch(/2026/);
    expect(out).not.toBe('2026-10-01');
    // determinismo
    expect(out).toBe(fmtFecha('2026-10-01'));
  });

  it('getColCount: 4 base + adjudicatario + fuente', () => {
    expect(getColCount(false, false)).toBe(4);
    expect(getColCount(true, false)).toBe(5);
    expect(getColCount(false, true)).toBe(5);
    expect(getColCount(true, true)).toBe(6);
  });
});

describe('filters — estado, rangos y query del API', () => {
  const base = {
    filters: [],
    selectedEstados: new Set<string>(),
    selectedFuentes: new Set<string>(),
    selectedCpvs: new Set<string>(),
    selectedImporte: null,
    sortCol: 'fecha',
    sortDir: -1,
    estadosDefault: ['en_proceso', 'adjudicado'],
    filterActivas: false,
    sortByAdj: false,
    showRelevance: false,
  };

  it('buildMonitorQuery: estados por defecto siempre presentes; limit 200; dir desc con sortDir -1', () => {
    const p = buildMonitorQuery(base, 1);
    expect(p.get('estados')).toBe('en_proceso,adjudicado');
    expect(p.get('limit')).toBe('200');
    expect(p.get('page')).toBe('1');
    expect(p.get('sort')).toBe('fecha');
    expect(p.get('dir')).toBe('desc');
    expect(p.has('q')).toBe(false);
  });

  it('buildMonitorQuery: texto y organismos desde chips (q une con espacios, organismos con comas)', () => {
    const p = buildMonitorQuery(
      {
        ...base,
        filters: [
          { id: 1, type: 'text', value: 'pantalla', label: 'pantalla' },
          { id: 2, type: 'text', value: 'led', label: 'led' },
          { id: 3, type: 'org', value: 'Ayuntamiento de Getafe', label: 'org' },
        ],
      },
      3,
    );
    expect(p.get('q')).toBe('pantalla led');
    expect(p.get('organismos')).toBe('Ayuntamiento de Getafe');
    expect(p.get('page')).toBe('3');
  });

  it('buildMonitorQuery: cpvs y fuentes solo si hay selección; estados seleccionados pisan el default', () => {
    const p = buildMonitorQuery(
      {
        ...base,
        selectedCpvs: new Set(['71310', '43000']),
        selectedFuentes: new Set(['TED', 'PLACSP']),
        selectedEstados: new Set(['adjudicado']),
      },
      1,
    );
    expect(p.get('cpvs')).toBe('71310,43000');
    expect(p.get('fuentes')).toBe('TED,PLACSP');
    expect(p.get('estados')).toBe('adjudicado');
  });

  it('buildMonitorQuery: importe mínimo siempre; importe_max omitido con Infinity', () => {
    const cerrado = buildMonitorQuery({ ...base, selectedImporte: IMP_RANGES[1] }, 1);
    expect(cerrado.get('importe_min')).toBe('50000');
    expect(cerrado.get('importe_max')).toBe('200000');
    const abierto = buildMonitorQuery({ ...base, selectedImporte: IMP_RANGES[4] }, 1);
    expect(abierto.get('importe_min')).toBe('5000000');
    expect(abierto.has('importe_max')).toBe(false);
  });

  it('buildMonitorQuery: relevance gana solo con texto y showRelevance; columna desconocida cae a fecha; adjudicatario solo con sortByAdj', () => {
    const conTexto = { ...base, filters: [{ id: 1, type: 'text', value: 'led', label: 'led' }] };
    expect(buildMonitorQuery({ ...conTexto, showRelevance: true }, 1).get('sort')).toBe('relevance');
    expect(buildMonitorQuery({ ...conTexto, showRelevance: false }, 1).get('sort')).toBe('fecha');
    expect(buildMonitorQuery({ ...base, sortCol: 'inventada' }, 1).get('sort')).toBe('fecha');
    expect(buildMonitorQuery({ ...base, sortByAdj: true, sortCol: 'adjudicatario' }, 1).get('sort')).toBe('adjudicatario');
    expect(buildMonitorQuery({ ...base, sortCol: 'adjudicatario' }, 1).get('sort')).toBe('fecha');
    expect(buildMonitorQuery({ ...base, sortCol: 'importe', sortDir: 1 }, 1).get('dir')).toBe('asc');
  });

  it('buildMonitorQuery: flag activas', () => {
    expect(buildMonitorQuery({ ...base, filterActivas: true }, 1).get('activas')).toBe('true');
    expect(buildMonitorQuery(base, 1).has('activas')).toBe(false);
  });

  it('hasActiveFilters: false solo con todo vacío; cualquier fuente activa lo activa', () => {
    const s = {
      filters: [] as any[],
      selectedEstados: new Set<string>(),
      selectedFuentes: new Set<string>(),
      selectedCpvs: new Set<string>(),
      selectedImporte: null as any,
    };
    expect(hasActiveFilters(s)).toBe(false);
    expect(hasActiveFilters({ ...s, filters: [{ id: 1, type: 'text', value: 'x', label: 'x' }] })).toBe(true);
    expect(hasActiveFilters({ ...s, selectedEstados: new Set(['a']) })).toBe(true);
    expect(hasActiveFilters({ ...s, selectedFuentes: new Set(['TED']) })).toBe(true);
    expect(hasActiveFilters({ ...s, selectedCpvs: new Set(['71310']) })).toBe(true);
    expect(hasActiveFilters({ ...s, selectedImporte: IMP_RANGES[0] })).toBe(true);
  });

  it('isEstadoActive: sin selección manda el default; con selección, el Set', () => {
    const defaults = ['en_proceso', 'adjudicado'];
    expect(isEstadoActive('en_proceso', new Set(), defaults)).toBe(true);
    expect(isEstadoActive('resuelto', new Set(), defaults)).toBe(false);
    expect(isEstadoActive('resuelto', new Set(['resuelto']), defaults)).toBe(true);
    expect(isEstadoActive('en_proceso', new Set(['resuelto']), defaults)).toBe(false);
  });

  it('isDuplicateFilter: dedup por (type, value)', () => {
    const filters = [{ type: 'text', value: 'led' }];
    expect(isDuplicateFilter(filters, 'text', 'led')).toBe(true);
    expect(isDuplicateFilter(filters, 'text', 'oled')).toBe(false);
    expect(isDuplicateFilter(filters, 'org', 'led')).toBe(false);
  });

  it('nextFilterId: max(id)+1 sobre los chips guardados', () => {
    expect(nextFilterId([{ id: 3 }, { id: 7 }])).toBe(8);
    expect(nextFilterId([{ id: 0 }])).toBe(1);
  });

  it('IMP_RANGES: el rango abierto 5m+ tiene max Infinity y findImpRange resuelve por key', () => {
    expect(findImpRange('5m+')).toBe(IMP_RANGES[4]);
    expect(IMP_RANGES[4].max).toBe(Infinity);
    expect(findImpRange('no-existe')).toBeNull();
  });

  it('serializeFilterState: forma exacta del localStorage; parseFilterState tolera corruptos', () => {
    const raw = serializeFilterState({
      filters: [{ id: 1, type: 'text', value: 'led', label: 'led' }],
      selectedEstados: new Set(['adjudicado']),
      selectedFuentes: new Set(),
      selectedImporte: null,
      sortCol: 'importe',
      sortDir: 1,
    });
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed).sort()).toEqual(
      ['activeFilters', 'selectedEstados', 'selectedFuentes', 'selectedImporte', 'sortCol', 'sortDir'].sort(),
    );
    expect(parsed.selectedEstados).toEqual(['adjudicado']);
    expect(parseFilterState(raw)).toEqual(parsed);
    expect(parseFilterState(null)).toBeNull();
    expect(parseFilterState('{corrupto')).toBeNull();
  });
});

describe('matching — dropdowns CPV y buscador principal', () => {
  const cpvDict: Record<string, string> = {
    '71310000': 'Servicios de ingeniería.',
    '71311000': 'Servicios de ingeniería civil.',
    '31700000': 'Tarjetas electrónicas.',
    '43000000': 'Máquinas y equipos.',
  };

  it('matchCpvDropdown: descripción contiene q o código empieza por q; excluye seleccionados; tope 15', () => {
    const m = matchCpvDropdown(cpvDict, 'ingeniería', new Set());
    expect(m.map(([code]) => code)).toEqual(['71310000', '71311000']);
    const porCodigo = matchCpvDropdown(cpvDict, '7131', new Set());
    expect(porCodigo.map(([code]) => code)).toEqual(['71310000', '71311000']);
    const conSel = matchCpvDropdown(cpvDict, 'ingeniería', new Set(['71310']));
    expect(conSel.map(([code]) => code)).toEqual(['71311000']);
    const muchos: Record<string, string> = {};
    for (let i = 0; i < 20; i++) muchos[`71${String(i).padStart(6, '0')}`] = `Ingeniería variante ${i}`;
    expect(matchCpvDropdown(muchos, 'ingeniería', new Set())).toHaveLength(15);
  });

  it('matchAutocomplete: 5 organismos máximo; 7 CPVs máximo con punto final retirado', () => {
    const orgs = Array.from({ length: 8 }, (_, i) => ({ nombre: `Ayuntamiento ${i}`, count: i }));
    const r = matchAutocomplete(orgs, cpvDict, 'ayuntamiento');
    expect(r.orgs).toHaveLength(5);
    const r2 = matchAutocomplete([], cpvDict, 'ingeniería');
    expect(r2.cpvs).toHaveLength(2);
    expect(r2.cpvs[0].desc).toBe('Servicios de ingeniería'); // sin el punto final
    expect(r2.cpvs[0].code).toBe('71310000');
  });

  it('cpvLabel: dict directo con fallbacks code+000/code+00/code, sin punto y truncado a 30', () => {
    expect(cpvLabel(cpvDict, '71310000')).toBe('Servicios de ingeniería');
    expect(cpvLabel(cpvDict, '71310')).toBe('Servicios de ingeniería'); // 71310+000
    expect(cpvLabel(cpvDict, '71311')).toBe('Servicios de ingeniería civil'); // 71311+000
    expect(cpvLabel({ '430000': 42 as any }, '430000')).toBe('430000'); // no-string → code
    const largo = 'X'.repeat(40) + '.';
    expect(cpvLabel({ '99000': largo }, '99000')).toBe('X'.repeat(30));
    expect(cpvLabel({}, '12345')).toBe('12345'); // code+00 fallback inexistente → code
  });
});

describe('sort — toggle de cabeceras', () => {
  it('misma columna invierte la dirección', () => {
    expect(nextSortState('fecha', -1, 'fecha')).toEqual({ col: 'fecha', dir: 1 });
    expect(nextSortState('fecha', 1, 'fecha')).toEqual({ col: 'fecha', dir: -1 });
  });

  it('columna nueva: fecha/importe arrancan descendente; resto ascendente', () => {
    expect(nextSortState('fecha', 1, 'importe')).toEqual({ col: 'importe', dir: -1 });
    expect(nextSortState('importe', -1, 'objeto')).toEqual({ col: 'objeto', dir: 1 });
    expect(nextSortState('objeto', 1, 'organismo')).toEqual({ col: 'organismo', dir: 1 });
    expect(nextSortState('objeto', 1, 'fecha')).toEqual({ col: 'fecha', dir: -1 });
  });
});
