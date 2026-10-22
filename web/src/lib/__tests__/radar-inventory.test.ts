/**
 * Regression tests for the radar inventory model.
 *
 * These tests target the defects found in review of T4 (commit 5a95915):
 * 1. validateDuration accepted NaN/Infinity
 * 2. validateRecord did not enforce status/basis/date/start/duration coherence
 *    nor invoke fecha_fin semantics
 * 3. coverage used constant schema-projection metrics without data, and treated
 *    fecha_fin as a required renewal field; it did not measure duration/inicio/evidencia
 * 4. dedup used id alone, ignoring fuente/lote/version
 * 5. PLACE source was omitted
 * 6. comments carried unverified record counts
 *
 * They are NOT tautological: they feed real inputs and assert the validation
 * outcome, rather than merely re-asserting constant tables.
 */
import { describe, it, expect } from 'vitest';
import {
  validateRecord,
  validateDuration,
  validateConfidence,
  DURATION_UNIT_VALID,
  FECHA_FIN_SEMANTICS,
  SOURCE_COLUMNS,
  FECHA_FIN_MAPPING,
  isValidISODate,
  AWARD_PROXY_FECHAFIN_SOURCES,
  type RadarRecord,
  type SourceName,
} from '../radar/inventory';
import {
  ALL_FIXTURES,
  FIXTURE_PLACSP_DEADLINE,
  FIXTURE_PLACE_DEADLINE,
  FIXTURE_TED_AWARD,
  FIXTURE_ANDALUCIA_DEADLINE,
  FIXTURE_GALICIA_NO_DATE,
  FIXTURE_MADRID_NO_DATE,
  FIXTURE_CATALUNYA_ADJUDICACIO,
  FIXTURE_VALENCIA_FORMALITZACIO,
  FIXTURE_EUSKADI_MIXED,
  FIXTURE_INVALID_DURATION,
  FIXTURE_INVALID_CONFIDENCE,
  FIXTURE_INCONSISTENT_ESTIMATION,
  FIXTURE_NO_AWARD_ANCHOR,
} from '../radar/samples';
import {
  analyzeCoverage,
  findDuplicates,
  validateAllUnits,
  findMissingFields,
  dedupKey,
} from '../radar/coverage';

// ─── Regression: validateDuration rejects NaN/Infinity ───────────────

describe('validateDuration rejects non-finite values', () => {
  it('rejects NaN valor', () => {
    expect(validateDuration({ valor: NaN, unidad: 'MON' })).toContain('finite');
  });

  it('rejects Infinity valor', () => {
    expect(validateDuration({ valor: Infinity, unidad: 'MON' })).toContain('finite');
  });

  it('rejects -Infinity valor', () => {
    expect(validateDuration({ valor: -Infinity, unidad: 'MON' })).toContain('finite');
  });

  it('rejects non-numeric valor', () => {
    expect(validateDuration({ valor: '6' as any, unidad: 'MON' })).toContain('finite');
  });

  it('rejects zero and negative valor', () => {
    expect(validateDuration({ valor: 0, unidad: 'MON' })).toContain('> 0');
    expect(validateDuration({ valor: -1, unidad: 'DAY' })).toContain('> 0');
  });

  it('rejects invalid unit WEEK', () => {
    expect(validateDuration({ valor: 6, unidad: 'WEEK' as any })).toContain('DAY/MON/ANN');
  });

  it('null is valid (not_estimable)', () => {
    expect(validateDuration(null)).toBeNull();
  });

  it('valid DAY/MON/ANN durations pass', () => {
    expect(validateDuration({ valor: 30, unidad: 'DAY' })).toBeNull();
    expect(validateDuration({ valor: 12, unidad: 'MON' })).toBeNull();
    expect(validateDuration({ valor: 2, unidad: 'ANN' })).toBeNull();
  });
});

// ─── Regression: validateConfidence stays null-only ───────────────────

describe('validateConfidence', () => {
  it('null is valid', () => {
    expect(validateConfidence({ confidence: null } as any)).toBeNull();
  });

  it('rejects non-null confidence', () => {
    expect(validateConfidence({ confidence: 'high' } as any)).toContain('must be null');
    expect(validateConfidence({ confidence: 0.8 } as any)).toContain('must be null');
  });
});

// ─── Regression: validateRecord coherence status/basis/date/start/duration ──

describe('validateRecord coherence', () => {
  it('valid not_estimable record passes', () => {
    expect(validateRecord(FIXTURE_PLACSP_DEADLINE)).toEqual([]);
  });

  it('valid PLACE record passes (source was omitted before)', () => {
    expect(validateRecord(FIXTURE_PLACE_DEADLINE)).toEqual([]);
  });

  it('valid award_proxy_scenario (TED) passes', () => {
    expect(validateRecord(FIXTURE_TED_AWARD)).toEqual([]);
  });

  it('valid award_proxy_scenario (VALENCIA) passes', () => {
    expect(validateRecord(FIXTURE_VALENCIA_FORMALITZACIO)).toEqual([]);
  });

  it('not_estimable with estimated_end_date is rejected', () => {
    const errs = validateRecord(FIXTURE_INCONSISTENT_ESTIMATION);
    expect(errs.some(e => e.includes('estimated_end_date'))).toBe(true);
  });

  it('award_proxy_scenario without award anchor is rejected', () => {
    const errs = validateRecord(FIXTURE_NO_AWARD_ANCHOR);
    expect(errs.some(e => e.includes('award'))).toBe(true);
  });

  it('contractual_scenario requires fecha_inicio', () => {
    const rec = { ...FIXTURE_TED_AWARD, estimation_status: 'contractual_scenario' as const, basis: 'explicit_start' as const };
    const errs = validateRecord(rec);
    expect(errs.some(e => e.includes('fecha_inicio'))).toBe(true);
  });

  it('contractual_scenario requires basis=explicit_start', () => {
    const rec = { ...FIXTURE_TED_AWARD, estimation_status: 'contractual_scenario' as const, basis: 'explicit_award_proxy' as const, fecha_inicio: '2024-07-01' };
    const errs = validateRecord(rec);
    expect(errs.some(e => e.includes('explicit_start'))).toBe(true);
  });

  it('not_estimable with a basis is rejected', () => {
    const rec = { ...FIXTURE_PLACSP_DEADLINE, basis: 'explicit_start' as const };
    const errs = validateRecord(rec);
    expect(errs.some(e => e.includes('basis'))).toBe(true);
  });

  it('invalid ISO dates are rejected (e.g. Feb 30, bad month)', () => {
    const rec = { ...FIXTURE_PLACSP_DEADLINE, fecha_fin: '2024-02-30' };
    const errs = validateRecord(rec);
    expect(errs.some(e => e.includes('fecha_fin'))).toBe(true);
  });

  it('invalid estimation_status is rejected', () => {
    const rec = { ...FIXTURE_PLACSP_DEADLINE, estimation_status: 'maybe' as any };
    expect(validateRecord(rec).some(e => e.includes('estimation_status'))).toBe(true);
  });
});

// ─── Regression: validateRecord invokes fecha_fin semantics ───────────

describe('validateRecord invokes fecha_fin semantics', () => {
  it('GALICIA (no fecha_fin column) with fecha_fin set is rejected', () => {
    const rec = { ...FIXTURE_GALICIA_NO_DATE, fecha_fin: '2024-12-31', evidencia: { campo_fuente: 'fecha_limite' } };
    const errs = validateRecord(rec);
    expect(errs.some(e => e.includes('no fecha_fin column'))).toBe(true);
  });

  it('PLACSP with a non-allowed campo_fuente is rejected', () => {
    const rec = { ...FIXTURE_PLACSP_DEADLINE, evidencia: { campo_fuente: 'DT_AWARD' } };
    const errs = validateRecord(rec);
    expect(errs.some(e => e.includes('not in allowed'))).toBe(true);
  });

  it('fecha_fin without evidencia.campo_fuente is rejected', () => {
    const rec = { ...FIXTURE_PLACSP_DEADLINE, evidencia: { campo_fuente: '' } };
    const errs = validateRecord(rec);
    expect(errs.some(e => e.includes('evidencia'))).toBe(true);
  });

  it('award_proxy not allowed for EUSKADI (mixed fecha_fin) by default', () => {
    expect(AWARD_PROXY_FECHAFIN_SOURCES.has('EUSKADI')).toBe(false);
  });

  it('award_proxy allowed for TED/CATALUNYA/VALENCIA', () => {
    expect(AWARD_PROXY_FECHAFIN_SOURCES.has('TED')).toBe(true);
    expect(AWARD_PROXY_FECHAFIN_SOURCES.has('CATALUNYA')).toBe(true);
    expect(AWARD_PROXY_FECHAFIN_SOURCES.has('VALENCIA')).toBe(true);
  });
});

// ─── Regression: PLACE source present ─────────────────────────────────

describe('PLACE source present', () => {
  it('PLACE is a valid source name', () => {
    expect(FECHA_FIN_SEMANTICS.PLACE).toBeDefined();
    expect(SOURCE_COLUMNS.PLACE).toBeDefined();
    expect(FECHA_FIN_MAPPING.PLACE.kind).toBe('fields');
  });

  it('PLACE fixture validates', () => {
    expect(validateRecord(FIXTURE_PLACE_DEADLINE)).toEqual([]);
  });
});

// ─── Regression: coverage measures data, not constant schema ──────────

describe('analyzeCoverage measures data completeness', () => {
  it('returns NO-GO when lineage unconfirmed', () => {
    const report = analyzeCoverage(ALL_FIXTURES);
    expect(report.gate).toBe('NO-GO');
    expect(report.lineageConfirmed).toBe(false);
    expect(report.blockers.some(b => b.includes('lineage'))).toBe(true);
  });

  it('counts synthetic vs real records correctly', () => {
    const report = analyzeCoverage(ALL_FIXTURES);
    expect(report.syntheticRecords).toBe(ALL_FIXTURES.length);
    expect(report.realRecords).toBe(0);
  });

  it('reports 0 real records as a blocker (no data completeness)', () => {
    const report = analyzeCoverage(ALL_FIXTURES);
    expect(report.blockers.some(b => b.includes('0 real records'))).toBe(true);
  });

  it('measures duracion completeness over actual records', () => {
    const report = analyzeCoverage(ALL_FIXTURES);
    const dur = report.fields.find(f => f.field === 'duracion')!;
    const expected = ALL_FIXTURES.filter(r => r.duracion !== null).length / ALL_FIXTURES.length;
    expect(dur.ratio).toBeCloseTo(expected, 5);
    expect(dur.recordsWithField).toBeGreaterThan(0);
  });

  it('does NOT require fecha_fin as a renewal field', () => {
    const report = analyzeCoverage(ALL_FIXTURES);
    const ff = report.fields.find(f => f.field === 'fecha_fin');
    expect(ff).toBeUndefined();
    expect(report.fields.some(f => f.required && f.field === 'fecha_fin')).toBe(false);
  });

  it('requires duracion, fecha_inicio, evidencia fields', () => {
    const report = analyzeCoverage(ALL_FIXTURES);
    for (const f of ['duracion', 'fecha_inicio', 'evidencia']) {
      const field = report.fields.find(x => x.field === f)!;
      expect(field.required).toBe(true);
    }
  });

  it('duracion completeness is not a constant — varies with input', () => {
    const reportA = analyzeCoverage(ALL_FIXTURES);
    const reportB = analyzeCoverage([FIXTURE_PLACSP_DEADLINE]); // all null duracion
    const durA = reportA.fields.find(f => f.field === 'duracion')!;
    const durB = reportB.fields.find(f => f.field === 'duracion')!;
    expect(durA.ratio).toBeGreaterThan(durB.ratio);
  });
});

// ─── Regression: dedup by fuente+id+lote+version ──────────────────────

describe('dedup by fuente+id+lote+version', () => {
  it('no duplicates in fixtures', () => {
    expect(findDuplicates(ALL_FIXTURES)).toHaveLength(0);
  });

  it('same id across different sources is NOT a duplicate', () => {
    const a = { ...FIXTURE_PLACSP_DEADLINE };
    const b = { ...FIXTURE_PLACSP_DEADLINE, fuente: 'TED' as SourceName };
    expect(findDuplicates([a, b])).toHaveLength(0);
  });

  it('same id+fuente but different lote is NOT a duplicate', () => {
    const a = { ...FIXTURE_TED_AWARD };
    const b = { ...FIXTURE_TED_AWARD, lote: 'LOTE-2' };
    expect(findDuplicates([a, b])).toHaveLength(0);
  });

  it('same id+fuente but different version is NOT a duplicate', () => {
    const a = { ...FIXTURE_TED_AWARD };
    const b = { ...FIXTURE_TED_AWARD, version: 'v2' };
    expect(findDuplicates([a, b])).toHaveLength(0);
  });

  it('identical key (fuente+id+lote+version) IS a duplicate', () => {
    const a = { ...FIXTURE_TED_AWARD };
    const b = { ...FIXTURE_TED_AWARD };
    expect(findDuplicates([a, b])).toContain(dedupKey(a));
  });

  it('dedupKey includes fuente, id, lote, version', () => {
    const rec = { ...FIXTURE_TED_AWARD, lote: 'L1', version: 'v1' };
    expect(dedupKey(rec)).toBe('TED|SYNTH-TED-1|L1|v1');
  });
});

// ─── Unit + missing-field validation over fixtures ────────────────────

describe('validateAllUnits', () => {
  it('flags only the invalid duration unit fixture', () => {
    const issues = validateAllUnits(ALL_FIXTURES);
    expect(issues.every(i => i.includes('SYNTH-PLACSP-2'))).toBe(true);
    expect(issues.length).toBe(1);
  });
});

describe('findMissingFields', () => {
  it('all fixtures have required structural fields', () => {
    expect(findMissingFields(ALL_FIXTURES)).toHaveLength(0);
  });
});

// ─── ISO date helper ──────────────────────────────────────────────────

describe('isValidISODate', () => {
  it('accepts valid dates', () => {
    expect(isValidISODate('2024-06-15')).toBe(true);
    expect(isValidISODate(null)).toBe(true);
  });

  it('rejects invalid dates', () => {
    expect(isValidISODate('2024-02-30')).toBe(false);
    expect(isValidISODate('2024-13-01')).toBe(false);
    expect(isValidISODate('15/06/2024')).toBe(false);
  });
});

// ─── Sanity: duration unit set and semantics tables ───────────────────

describe('duration units', () => {
  it('exposes DAY/MON/ANN only', () => {
    expect([...DURATION_UNIT_VALID]).toEqual(['DAY', 'MON', 'ANN']);
  });
});
