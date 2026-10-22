/**
 * Synthetic tests for the Radar temporal estimator (T5).
 *
 * Cover all rules from radar-temporal-contract-review.md:
 * 1. No duration / no unit → not_estimable, null end date.
 * 2. Explicit start + valid duration → contractual_scenario.
 * 3. Award proxy + valid duration → award_proxy_scenario.
 * 4. fecha_fin (deadline) alone → not_estimable.
 * 5. DT_DISPATCH / fecha_publicacion NOT used as start.
 * 6. Calendar arithmetic tested (months, leap year, end-of-month).
 * 7. Prórroga stays unknown (never zero).
 * 8. confidence always null.
 * 9. No auto-aggregation of lots/duplicates (adapter keeps unit).
 * 10. No +365 fallback.
 */

import { describe, it, expect } from 'vitest';
import {
  estimate,
} from '../radar/estimator';
import type { RadarEstimate } from '../radar/estimator';
import { adapt, isAdaptable, isValidEvidenceField, isAwardProxyEvidence } from '../radar/adapter';
import type { RawSourceRecord } from '../radar/adapter';
import {
  addMonths,
  addDays,
  addYears,
  isLeapYear,
  daysInMonth,
} from '../radar/calendar';
import type { RadarRecord } from '../radar/inventory';

// ─── Fixtures (minimal raw records for adapter → estimator pipeline) ─

function makeRaw(partial: Partial<RawSourceRecord> & { id: string }): RawSourceRecord {
  // Destructure known defaults so spread doesn't overwrite them
  const { id, fuente, expediente, organismo, objeto, ...rest } = partial;
  return {
    id,
    fuente: fuente ?? 'PLACSP',
    expediente: expediente ?? 'EXP-001',
    organismo: organismo ?? 'Ministerio Test',
    objeto: objeto ?? 'Servicio de test',
    ...rest,
  };
}

// ─── Rule 1: No duration / invalid duration → not_estimable ──────────

describe('Rule 1: no duration / invalid duration → not_estimable', () => {
  it('null duration with valid start → not_estimable', () => {
    const raw = makeRaw({
      id: 'test-no-dur',
      fecha_inicio: '2024-01-15',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBeNull();
    expect(result.estimation_status).toBe('not_estimable');
    expect(result.basis).toBeNull();
  });

  it('zero valor → not_estimable', () => {
    const raw = makeRaw({
      id: 'test-zero-dur',
      fecha_inicio: '2024-01-15',
      duracion_valor: 0,
      duracion_unidad: 'DAY',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimation_status).toBe('not_estimable');
  });

  it('invalid unit (WEEK) → not_estimable even with fecha_inicio', () => {
    const raw = makeRaw({
      id: 'test-week-unit',
      fuente: 'PLACSP',
      fecha_inicio: '2024-03-01',
      duracion_valor: 30,
      duracion_unidad: 'WEEK',
    });
    const rec = adapt(raw);
    expect(rec.duracion).toBeNull();
    const result = estimate(rec);
    expect(result.estimation_status).toBe('not_estimable');
  });

  it('negative valor → not_estimable', () => {
    const raw = makeRaw({
      id: 'test-neg-dur',
      fuente: 'TED',
      fecha_adjudicacion: '2024-01-15',
      duracion_valor: -12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimation_status).toBe('not_estimable');
  });

  it('null unit → duration unusable → not_estimable', () => {
    const raw = makeRaw({
      id: 'test-null-unit',
      fecha_inicio: '2024-01-15',
      duracion_valor: 6,
      duracion_unidad: null,
    });
    const rec = adapt(raw);
    expect(rec.duracion).toBeNull();
  });
});

// ─── Rule 2: Explicit start + valid duration → contractual_scenario ──

describe('Rule 2: explicit start + valid duration → contractual_scenario', () => {
  it('DAY duration: 2024-01-15 + 30 DAY → 2024-02-14', () => {
    const raw = makeRaw({
      id: 'test-start-day',
      fuente: 'PLACSP',
      fecha_inicio: '2024-01-15',
      duracion_valor: 30,
      duracion_unidad: 'DAY',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBe('2024-02-14');
    expect(result.estimation_status).toBe('contractual_scenario');
    expect(result.basis).toBe('explicit_start');
  });

  it('MONTH duration: 2024-03-01 + 6 MON → 2024-09-01', () => {
    const raw = makeRaw({
      id: 'test-start-month',
      fuente: 'PLACSP',
      fecha_inicio: '2024-03-01',
      duracion_valor: 6,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBe('2024-09-01');
    expect(result.estimation_status).toBe('contractual_scenario');
  });

  it('YEAR duration: 2024-06-15 + 2 ANN → 2026-06-15', () => {
    const raw = makeRaw({
      id: 'test-start-year',
      fuente: 'MADRID',
      fecha_inicio: '2024-06-15',
      duracion_valor: 2,
      duracion_unidad: 'ANN',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBe('2026-06-15');
    expect(result.estimation_status).toBe('contractual_scenario');
  });

  it('Spanish unit "MES" normalizes to MON', () => {
    const raw = makeRaw({
      id: 'test-mes-unit',
      fecha_inicio: '2024-01-10',
      duracion_valor: 12,
      duracion_unidad: 'MES',
    });
    const rec = adapt(raw);
    expect(rec.duracion?.unidad).toBe('MON');
    const result = estimate(rec);
    expect(result.estimated_end_date).toBe('2025-01-10');
  });

  it('Spanish unit "AÑO" normalizes to ANN', () => {
    const raw = makeRaw({
      id: 'test-anio-unit',
      fuente: 'ANDALUCIA',
      fecha_inicio: '2024-01-10',
      duracion_valor: 1,
      duracion_unidad: 'AÑO',
    });
    const rec = adapt(raw);
    expect(rec.duracion?.unidad).toBe('ANN');
    const result = estimate(rec);
    expect(result.estimated_end_date).toBe('2025-01-10');
  });
});

// ─── Rule 3: Award proxy + valid duration → award_proxy_scenario ─────

describe('Rule 3: award proxy + valid duration → award_proxy_scenario', () => {
  it('fecha_adjudicacion + MONTH duration → award_proxy_scenario', () => {
    const raw = makeRaw({
      id: 'test-adjudicacion-month',
      fuente: 'TED',
      fecha_adjudicacion: '2024-06-15',
      duracion_valor: 24,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBe('2026-06-15');
    expect(result.estimation_status).toBe('award_proxy_scenario');
    expect(result.basis).toBe('explicit_award_proxy');
  });

  it('TED fecha_fin (DT_AWARD) + ANN duration → award_proxy_scenario', () => {
    const raw = makeRaw({
      id: 'test-ted-award-fin',
      fuente: 'TED',
      fecha_fin: '2024-06-15',
      evidencia_campo_fuente: 'DT_AWARD',
      duracion_valor: 3,
      duracion_unidad: 'ANN',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBe('2027-06-15');
    expect(result.estimation_status).toBe('award_proxy_scenario');
  });

  it('CATALUNYA fecha_fin (adjudication) → award_proxy_scenario', () => {
    const raw = makeRaw({
      id: 'test-cat-adj',
      fuente: 'CATALUNYA',
      fecha_fin: '2024-05-20',
      evidencia_campo_fuente: 'DATA_PUBLICACIO_ADJUDICACIO',
      duracion_valor: 36,
      duracion_unidad: 'MES',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBe('2027-05-20');
    expect(result.estimation_status).toBe('award_proxy_scenario');
  });

  it('VALENCIA fecha_fin (formalization) → award_proxy_scenario', () => {
    const raw = makeRaw({
      id: 'test-val-form',
      fuente: 'VALENCIA',
      fecha_fin: '2024-06-15',
      evidencia_campo_fuente: 'FECHA_FORMALIZACION',
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBe('2025-06-15');
    expect(result.estimation_status).toBe('award_proxy_scenario');
  });

  it('fecha_adjudicacion takes priority over fecha_fin for anchor', () => {
    const raw = makeRaw({
      id: 'test-priority',
      fuente: 'TED',
      fecha_fin: '2024-06-15', // not the real anchor
      fecha_adjudicacion: '2024-08-01', // real anchor
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBe('2025-08-01');
    expect(result.reason).toContain('fecha_adjudicacion');
  });
});

// ─── Rule 4: fecha_fin (deadline) alone → not_estimable ──────────────

describe('Rule 4: fecha_fin (deadline) alone → not_estimable', () => {
  it('PLACSP fecha_fin = deadline, no start → not_estimable', () => {
    const raw = makeRaw({
      id: 'test-placsp-deadline',
      fuente: 'PLACSP',
      fecha_fin: '2024-04-15',
      evidencia_campo_fuente: 'fecha_limite',
      duracion_valor: 6,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBeNull();
    expect(result.estimation_status).toBe('not_estimable');
    expect(result.basis).toBeNull();
  });

  it('ANDALUCIA fecha_fin = deadline → not_estimable', () => {
    const raw = makeRaw({
      id: 'test-andalucia-deadline',
      fuente: 'ANDALUCIA',
      fecha_fin: '2024-03-01',
      evidencia_campo_fuente: 'fecha_limite_presentacion',
      duracion_valor: 12,
      duracion_unidad: 'MES',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimation_status).toBe('not_estimable');
  });

  it('fecha_fin + fecha_adjudicacion → award_proxy (adjudicacion wins)', () => {
    const raw = makeRaw({
      id: 'test-both-anchors',
      fuente: 'TED',
      fecha_fin: '2024-04-15', // deadline (but source is TED)
      fecha_adjudicacion: '2024-06-01',
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    // fecha_adjudicacion takes priority
    expect(result.basis).toBe('explicit_award_proxy');
    expect(result.estimated_end_date).toBe('2025-06-01');
  });
});

// ─── Rule 5: DT_DISPATCH / fecha_publicacion NOT used as start ───────

describe('Rule 5: DT_DISPATCH / fecha_publicacion NOT used as start', () => {
  it('fecha_publicacion alone → not_estimable (no start inferred)', () => {
    const raw = makeRaw({
      id: 'test-publication',
      fuente: 'PLACSP',
      fecha_publicacion: '2024-03-15',
      duracion_valor: 6,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimation_status).toBe('not_estimable');
    expect(result.estimated_end_date).toBeNull();
  });

  it('TED with DT_DISPATCH as fecha_publicacion but no start → not_estimable', () => {
    const raw = makeRaw({
      id: 'test-ted-dispatch',
      fuente: 'TED',
      fecha_publicacion: '2024-03-20', // DT_DISPATCH
      duracion_valor: 24,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    // No fecha_adjudicacion and no award-proxy fecha_fin → not_estimable
    expect(result.estimation_status).toBe('not_estimable');
  });
});

// ─── Rule 6: Calendar arithmetic ─────────────────────────────────────

describe('Rule 6: calendar arithmetic (months, leap year, end-of-month)', () => {
  it('addMonths clamps to last day: Jan 31 + 1 month (leap year) → Feb 29', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
  });

  it('addMonths clamps to last day: Jan 31 + 1 month (non-leap) → Feb 28', () => {
    expect(addMonths('2023-01-31', 1)).toBe('2023-02-28');
  });

  it('addMonths clamps: Mar 31 + 1 month → Apr 30', () => {
    expect(addMonths('2024-03-31', 1)).toBe('2024-04-30');
  });

  it('addMonths across year boundary: Oct 31 + 3 months → Jan 31', () => {
    expect(addMonths('2024-10-31', 3)).toBe('2025-01-31');
  });

  it('addMonths negative: Jan 31 - 1 month → Dec 31', () => {
    expect(addMonths('2024-01-31', -1)).toBe('2023-12-31');
  });

  it('addYears leap: Feb 29 + 1 year → Feb 28', () => {
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
  });

  it('addYears leap roundtrip: 2024-02-29 + 4 years → 2028-02-29', () => {
    expect(addYears('2024-02-29', 4)).toBe('2028-02-29');
  });

  it('addYears clamps: Mar 31 + 1 year → Mar 31', () => {
    expect(addYears('2024-03-31', 1)).toBe('2025-03-31');
  });

  it('addDays normal: Jan 15 + 30 days → Feb 14', () => {
    expect(addDays('2024-01-15', 30)).toBe('2024-02-14');
  });

  it('addDays crosses month: Jan 15 + 20 days → Feb 4', () => {
    expect(addDays('2024-01-15', 20)).toBe('2024-02-04');
  });

  it('addDays negative: Feb 15 - 1 day → Feb 14', () => {
    expect(addDays('2024-02-15', -1)).toBe('2024-02-14');
  });

  it('daysInMonth: Feb 2024 (leap) = 29', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
  });

  it('daysInMonth: Feb 2023 (non-leap) = 28', () => {
    expect(daysInMonth(2023, 2)).toBe(28);
  });

  it('isLeapYear: 2024 true, 2023 false, 2000 true, 1900 false', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2023)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
  });
});

// ─── Rule 7: Prórroga stays unknown ──────────────────────────────────

describe('Rule 7: prórroga unknown (never zero or inferred)', () => {
  it('no proroga field in RadarRecord — estimator does not model it', () => {
    const raw = makeRaw({
      id: 'test-proroga',
      fuente: 'PLACSP',
      fecha_inicio: '2024-01-15',
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    // RadarRecord has no prorroga field by design — it's unknown
    // The estimator doesn't try to infer or zero it.
    const result = estimate(rec);
    // Result should NOT claim zero prorroga
    expect(result.reason).not.toContain('prorroga=0');
    expect(result.reason).not.toContain('prórroga');
  });
});

// ─── Rule 8: confidence always null ──────────────────────────────────

describe('Rule 8: confidence always null', () => {
  it('contractual_scenario → confidence null', () => {
    const raw = makeRaw({
      id: 'test-conf-start',
      fecha_inicio: '2024-01-15',
      duracion_valor: 6,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    expect(rec.confidence).toBeNull();
  });

  it('award_proxy_scenario → confidence null', () => {
    const raw = makeRaw({
      id: 'test-conf-award',
      fuente: 'TED',
      fecha_adjudicacion: '2024-06-15',
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    expect(rec.confidence).toBeNull();
  });
});

// ─── Rule 9: No auto-aggregation of lots/duplicates ──────────────────

describe('Rule 9: no auto-aggregation of lots/duplicates', () => {
  it('adapter preserves lote and version per record', () => {
    const raw = makeRaw({
      id: 'test-dup-lote',
      lote: 'LOTE-A',
      version: 'v1',
    });
    const rec = adapt(raw);
    expect(rec.lote).toBe('LOTE-A');
    expect(rec.version).toBe('v1');
  });

  it('same id different lote → separate records after adapt', () => {
    const raw1 = makeRaw({ id: 'SHARED-001-A', lote: 'LOTE-A' });
    const raw2 = makeRaw({ id: 'SHARED-001-B', lote: 'LOTE-B' });
    const rec1 = adapt(raw1);
    const rec2 = adapt(raw2);
    expect(rec1.lote).toBe('LOTE-A');
    expect(rec2.lote).toBe('LOTE-B');
    // Each record is estimated independently (not combined/aggregated)
    const e1 = estimate(rec1);
    const e2 = estimate(rec2);
    // Both should be not_estimable (no duration), each estimated separately
    expect(e1.estimation_status).toBe('not_estimable');
    expect(e2.estimation_status).toBe('not_estimable');
    // Independent calls, no aggregation: both null is correct, not a merged value
    expect(e1.estimated_end_date).toBeNull();
    expect(e2.estimated_end_date).toBeNull();
  });

  it('adapter keeps individual identity, no dedup performed', () => {
    const raw1 = makeRaw({ id: 'DUP-001' });
    const raw2 = makeRaw({ id: 'DUP-001' });
    const rec1 = adapt(raw1);
    const rec2 = adapt(raw2);
    // Both adapters succeed — no deduplication in the adapter
    expect(rec1.id).toBe(rec2.id);
    expect(rec1.lote).toBe(null);
    expect(rec2.lote).toBe(null);
  });
});

// ─── Rule 10: No +365 fallback ───────────────────────────────────────

describe('Rule 10: no +365 fallback when duration is missing', () => {
  it('no duration and no start → null end date, NOT +365', () => {
    const raw = makeRaw({
      id: 'test-no365',
      fuente: 'PLACSP',
      fecha_publicacion: '2024-03-15',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBeNull();
    expect(result.reason).toContain('no_duracion');
    expect(result.reason).not.toContain('365');
  });
});

// ─── isAdaptable checks ──────────────────────────────────────────────

describe('isAdaptable', () => {
  it('valid raw record returns true', () => {
    const raw = makeRaw({ id: 'test-valid' });
    expect(isAdaptable(raw)).toBe(true);
  });

  it('missing id returns false', () => {
    // Missing id — not adaptable
    expect(isAdaptable({ fuente: 'PLACSP' } as RawSourceRecord)).toBe(false);
  });

  it('unknown fuente returns false', () => {
    expect(isAdaptable({ id: 'test', fuente: 'UNKNOWN' } as unknown as RawSourceRecord)).toBe(false);
  });

  it('missing organismo returns false', () => {
    const raw = { id: 'test', fuente: 'PLACSP' as any, organismo: '' as any, expediente: 'EXP', objeto: 'Test' } as unknown as RawSourceRecord;
    expect(isAdaptable(raw)).toBe(false);
  });
});

// ─── Pipeline: adapt → estimate full round ────────────────────────────

describe('Pipeline: adapt → estimate', () => {
  it('TED award + 24 MONTH → 2026-06-15 award_proxy_scenario', () => {
    const raw = makeRaw({
      id: 'PIPELINE-TED-001',
      fuente: 'TED',
      lote: 'LOTE-1',
      version: 'v1',
      fecha_adjudicacion: '2024-06-15',
      duracion_valor: 24,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBe('2026-06-15');
    expect(result.estimation_status).toBe('award_proxy_scenario');
    expect(result.basis).toBe('explicit_award_proxy');
    expect(rec.confidence).toBeNull();
    expect(rec.evidencia.campo_fuente).toBe('unknown');
  });

  it('PLACSP deadline + duration → not_estimable (deadline is not start)', () => {
    const raw = makeRaw({
      id: 'PIPELINE-PLACSP-001',
      fuente: 'PLACSP',
      fecha_fin: '2024-04-15',
      evidencia_campo_fuente: 'fecha_limite',
      duracion_valor: 6,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBeNull();
    expect(result.estimation_status).toBe('not_estimable');
  });

  it('Contractual scenario: start + year duration', () => {
    const raw = makeRaw({
      id: 'PIPELINE-MAD-001',
      fuente: 'MADRID',
      fecha_inicio: '2024-02-29', // leap year
      duracion_valor: 3,
      duracion_unidad: 'ANN',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    // 2024-02-29 + 3 years → 2027-02-28 (2027 not leap)
    expect(result.estimated_end_date).toBe('2027-02-28');
    expect(result.estimation_status).toBe('contractual_scenario');
  });

  it('No date anchor at all → not_estimable with reason', () => {
    const raw = makeRaw({
      id: 'PIPELINE-NONE-001',
      fuente: 'GALICIA',
      duracion_valor: 6,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimated_end_date).toBeNull();
    expect(result.estimation_status).toBe('not_estimable');
    expect(result.reason).toContain('no_date_anchor');
  });
});

// ─── Evidence validation: fecha_fin without / incompatible evidence ──

describe('Evidence: fecha_fin without coherent evidence → not_estimable', () => {
  it('TED fecha_fin with unknown evidence → not_estimable (not award_proxy)', () => {
    const raw = makeRaw({
      id: 'test-ted-unknown-evidence',
      fuente: 'TED',
      fecha_fin: '2024-06-15',
      evidencia_campo_fuente: 'unknown',
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    // Evidence is 'unknown' — not in TED's allowed list → not award proxy
    const result = estimate(rec);
    expect(result.estimation_status).toBe('not_estimable');
    expect(result.basis).toBeNull();
  });

  it('TED fecha_fin with no evidencia field → not_estimable', () => {
    const raw = makeRaw({
      id: 'test-ted-no-evidence',
      fuente: 'TED',
      fecha_fin: '2024-06-15',
      evidencia_campo_fuente: null,
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimation_status).toBe('not_estimable');
  });

  it('TED fecha_fin with wrong evidence field → not_estimable', () => {
    const raw = makeRaw({
      id: 'test-ted-wrong-field',
      fuente: 'TED',
      fecha_fin: '2024-06-15',
      evidencia_campo_fuente: 'fecha_limite', // wrong — not allowed for TED
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimation_status).toBe('not_estimable');
  });

  it('CATALUNYA fecha_fin with valid evidence → award_proxy_scenario', () => {
    const raw = makeRaw({
      id: 'test-cat-valid',
      fuente: 'CATALUNYA',
      fecha_fin: '2024-05-20',
      evidencia_campo_fuente: 'DATA_PUB_ADJUDICACIO',
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimation_status).toBe('award_proxy_scenario');
    expect(result.basis).toBe('explicit_award_proxy');
  });

  it('CATALUNYA fecha_fin with invalid evidence → not_estimable', () => {
    const raw = makeRaw({
      id: 'test-cat-invalid',
      fuente: 'CATALUNYA',
      fecha_fin: '2024-05-20',
      evidencia_campo_fuente: 'DT_AWARD', // wrong — not allowed for CATALUNYA
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimation_status).toBe('not_estimable');
  });

  it('VALENCIA fecha_fin with valid evidence → award_proxy_scenario', () => {
    const raw = makeRaw({
      id: 'test-val-valid',
      fuente: 'VALENCIA',
      fecha_fin: '2024-06-15',
      evidencia_campo_fuente: 'FECHA_FORMALIZACION',
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimation_status).toBe('award_proxy_scenario');
  });

  it('VALENCIA fecha_fin with wrong evidence → not_estimable', () => {
    const raw = makeRaw({
      id: 'test-val-wrong',
      fuente: 'VALENCIA',
      fecha_fin: '2024-06-15',
      evidencia_campo_fuente: 'DT_AWARD', // wrong — not allowed for VALENCIA
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    const result = estimate(rec);
    expect(result.estimation_status).toBe('not_estimable');
  });

  it('EUSKADI mixed fecha_fin → not_estimable (not in proxy sources)', () => {
    const raw = makeRaw({
      id: 'test-euskadi',
      fuente: 'EUSKADI',
      fecha_fin: '2024-06-15',
      evidencia_campo_fuente: 'fecha_de_adjudicacion',
      duracion_valor: 12,
      duracion_unidad: 'MONTH',
    });
    const rec = adapt(raw);
    // EUSKADI is NOT in AWARD_PROXY_FECHAFIN_SOURCES (mixed semantics)
    const result = estimate(rec);
    expect(result.estimation_status).toBe('not_estimable');
  });
});

// ─── Evidence helper functions ────────────────────────────────────────

describe('Evidence validation helpers', () => {
  it('isValidEvidenceField: correct field returns true', () => {
    expect(isValidEvidenceField('TED', 'DT_AWARD')).toBe(true);
    expect(isValidEvidenceField('CATALUNYA', 'DATA_PUB_ADJUDICACIO')).toBe(true);
    expect(isValidEvidenceField('VALENCIA', 'FECHA_FORMALIZACION')).toBe(true);
  });

  it('isValidEvidenceField: wrong field returns false', () => {
    expect(isValidEvidenceField('TED', 'fecha_limite')).toBe(false);
    expect(isValidEvidenceField('CATALUNYA', 'DT_AWARD')).toBe(false);
    expect(isValidEvidenceField('VALENCIA', 'fecha_limite')).toBe(false);
  });

  it('isValidEvidenceField: null campo returns false', () => {
    expect(isValidEvidenceField('TED', null)).toBe(false);
  });

  it('isValidEvidenceField: GALICIA (no fecha_fin) allows marker', () => {
    expect(isValidEvidenceField('GALICIA', 'N/A (source lacks fecha_fin column)')).toBe(true);
    expect(isValidEvidenceField('GALICIA', 'DT_AWARD')).toBe(false);
  });

  it('isAwardProxyEvidence: TED with DT_AWARD returns true', () => {
    expect(isAwardProxyEvidence('TED', 'DT_AWARD')).toBe(true);
  });

  it('isAwardProxyEvidence: TED with unknown returns false', () => {
    expect(isAwardProxyEvidence('TED', 'unknown')).toBe(false);
  });

  it('isAwardProxyEvidence: non-proxy source returns false', () => {
    expect(isAwardProxyEvidence('PLACSP', 'DT_AWARD')).toBe(false);
    expect(isAwardProxyEvidence('ANDALUCIA', 'fecha_limite')).toBe(false);
    expect(isAwardProxyEvidence('EUSKADI', 'fecha_de_adjudicacion')).toBe(false);
  });
});