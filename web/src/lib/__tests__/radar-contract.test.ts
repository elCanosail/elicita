/**
 * T6 contract-first tests for Radar opportunities API.
 *
 * Tests:
 * 1. Zod contract schema validation (valid + invalid records)
 * 2. Safe-empty response when lineage unconfirmed
 * 3. Injection adapter query (filters, pagination, safe-empty)
 * 4. Opportunity conversion (RadarRecord → RadarOpportunity)
 * 5. Contract integrity: confidence always null, etc.
 *
 * Source: web/src/lib/__tests__/radar-contract.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  RadarOpportunitySchema,
  RadarQuerySchema,
  RadarResponseSchema,
  RadarSourceSchema,
  RadarEstimationStatusSchema,
  RadarBasisSchema,
  RadarDurationUnitSchema,
  RadarEvidenceSchema,
  RadarDurationSchema,
  validateOpportunity,
  safeEmptyResponse,
  type RadarOpportunity,
} from '../radar/contract';
import { queryRadar, isLineageConfirmed, getSafeExplanation } from '../radar/injection';
import type { RadarRecord } from '../radar/inventory';

// ─── Helper: build a minimal valid RadarRecord ──────────────────────

function validRecord(partial: Partial<RadarRecord> & { id: string }): RadarRecord {
  return {
    id: 'TEST-001',
    fuente: 'PLACSP',
    expediente: 'EXP-001',
    organismo: 'Test Org',
    objeto: 'Test object',
    cpv: '71311000',
    importe_licitacion: 100_000,
    importe_adjudicacion: null,
    adjudicatario: null,
    fecha_publicacion: '2024-01-15',
    fecha_adjudicacion: null,
    fecha_inicio: '2024-03-01',
    fecha_fin: '2025-03-01',
    url: null,
    duracion: { valor: 12, unidad: 'MON' },
    estimation_status: 'contractual_scenario',
    estimated_end_date: '2025-03-01',
    confidence: null,
    basis: 'explicit_start',
    evidencia: { campo_fuente: 'test' },
    es_sintetico: true,
    ...partial,
  };
}

// ─── 1. Zod contract: valid records ─────────────────────────────────

describe('RadarOpportunitySchema: valid records', () => {
  it('accepts a full contractual_scenario record', () => {
    const rec = validRecord({ id: 'TEST-VALID-1' });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.estimation_status).toBe('contractual_scenario');
      expect(result.data.estimated_end_date).toBe('2025-03-01');
      expect(result.data.basis).toBe('explicit_start');
    }
  });

  it('accepts an award_proxy_scenario record', () => {
    const rec = validRecord({
      id: 'TEST-VALID-2',
      fuente: 'TED',
      estimation_status: 'award_proxy_scenario',
      basis: 'explicit_award_proxy',
      fecha_inicio: null,
      fecha_adjudicacion: '2024-06-15',
      fecha_fin: '2024-06-15',
      duracion: { valor: 24, unidad: 'MON' },
      estimated_end_date: '2026-06-15',
      evidencia: { campo_fuente: 'DT_AWARD' },
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(true);
  });

  it('accepts a not_estimable record', () => {
    const rec = validRecord({
      id: 'TEST-VALID-3',
      fuente: 'PLACSP',
      estimation_status: 'not_estimable',
      basis: null,
      estimated_end_date: null,
      duracion: null,
      fecha_inicio: null,
      evidencia: { campo_fuente: 'fecha_limite' },
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.estimation_status).toBe('not_estimable');
      expect(result.data.estimated_end_date).toBeNull();
      expect(result.data.basis).toBeNull();
      expect(result.data.confidence).toBeNull();
    }
  });

  it('accepts optional lote and version', () => {
    const rec = validRecord({
      id: 'TEST-VALID-4',
      lote: 'LOTE-A',
      version: 'v1',
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lote).toBe('LOTE-A');
      expect(result.data.version).toBe('v1');
    }
  });
});

// ─── 2. Zod contract: invalid records ───────────────────────────────

describe('RadarOpportunitySchema: invalid records', () => {
  it('rejects non-null confidence', () => {
    const rec = validRecord({
      id: 'TEST-INV-1',
      confidence: 0.8 as any,
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(false);
  });

  it('rejects invalid estimation_status', () => {
    const rec = validRecord({
      id: 'TEST-INV-2',
      estimation_status: 'maybe' as any,
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(false);
  });

  it('rejects invalid duration unit', () => {
    const rec = validRecord({
      id: 'TEST-INV-3',
      duracion: { valor: 12, unidad: 'WEEK' as any },
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(false);
  });

  it('rejects invalid ISO dates', () => {
    const rec = validRecord({
      id: 'TEST-INV-4',
      fecha_inicio: '15/01/2024' as any,
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const rec = { id: 'TEST-INV-5' } as unknown as RadarRecord;
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(false);
  });

  it('rejects negative duration valor', () => {
    const rec = validRecord({
      id: 'TEST-INV-6',
      duracion: { valor: -1, unidad: 'DAY' },
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(false);
  });

  it('rejects zero duration valor', () => {
    const rec = validRecord({
      id: 'TEST-INV-7',
      duracion: { valor: 0, unidad: 'MON' },
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(false);
  });
});

// ─── 3. ValidateOpportunity helper ──────────────────────────────────

describe('validateOpportunity', () => {
  it('returns valid for a correct record', () => {
    const rec = validRecord({ id: 'TEST-VALIDATE-1' });
    const result = validateOpportunity(rec);
    expect(result.valid).toBe(true);
  });

  it('returns errors for an invalid record', () => {
    const rec = validRecord({
      id: 'TEST-VALIDATE-2',
      confidence: 'high' as any,
    });
    const result = validateOpportunity(rec);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.includes('confidence'))).toBe(true);
    }
  });
});

// ─── 4. Safe-empty response ─────────────────────────────────────────

describe('safeEmptyResponse', () => {
  it('returns empty opportunities with safe_empty status', () => {
    const resp = safeEmptyResponse('Lineage unconfirmed');
    expect(resp.opportunities).toEqual([]);
    expect(resp.pagination.total).toBe(0);
    expect(resp.meta.lineage_confirmed).toBe(false);
    expect(resp.meta.coverage_status).toBe('safe_empty');
    expect(resp.meta.explanation).toBe('Lineage unconfirmed');
  });

  it('produces a valid RadarResponse', () => {
    const resp = safeEmptyResponse('No data');
    const result = RadarResponseSchema.safeParse(resp);
    expect(result.success).toBe(true);
  });
});

// ─── 5. Injection adapter (LINEAGE_CONFIRMED = false) ───────────────

describe('queryRadar: lineage unconfirmed (safe-empty)', () => {
  it('returns empty when lineage is not confirmed', () => {
    expect(isLineageConfirmed()).toBe(false);
    const result = queryRadar({});
    expect(result.opportunities).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.lineageConfirmed).toBe(false);
    expect(result.safeEmpty).toBe(true);
  });

  it('filters have no effect when safe-empty', () => {
    const result = queryRadar({
      fuente: 'TED',
      estimation_status: 'contractual_scenario',
      cpv: '7131',
    });
    expect(result.opportunities).toEqual([]);
    expect(result.safeEmpty).toBe(true);
  });

  it('pagination has no effect when safe-empty', () => {
    const result = queryRadar({ offset: 100, limit: 50 });
    expect(result.opportunities).toEqual([]);
  });

  it('safe explanation is descriptive', () => {
    const expl = getSafeExplanation();
    // Explanation is in Spanish; check for key terms
    expect(expl.toLowerCase()).toContain('procedencia');
    expect(expl).toContain('cobertura');
  });
});

// ─── 6. Query params schema ─────────────────────────────────────────

describe('RadarQuerySchema', () => {
  it('accepts valid minimal query', () => {
    const result = RadarQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts all filter parameters', () => {
    const result = RadarQuerySchema.safeParse({
      fuente: 'TED',
      estimation_status: 'contractual_scenario',
      cpv: '7131',
      organismo: 'Ministry',
      limit: 50,
      offset: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fuente).toBe('TED');
      expect(result.data.limit).toBe(50);
    }
  });

  it('rejects limit > 100', () => {
    const result = RadarQuerySchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects limit < 1', () => {
    const result = RadarQuerySchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid source', () => {
    const result = RadarQuerySchema.safeParse({ fuente: 'UNKNOWN' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid estimation_status', () => {
    const result = RadarQuerySchema.safeParse({ estimation_status: 'maybe' });
    expect(result.success).toBe(false);
  });
});

// ─── 7. Contract integrity: no fabricated confidence ────────────────

describe('Contract integrity: confidence is always null', () => {
  it('valid record has confidence null', () => {
    const rec = validRecord({ id: 'TEST-INTEG-1' });
    const result = RadarOpportunitySchema.safeParse(rec);
    if (result.success) {
      expect(result.data.confidence).toBeNull();
    }
  });

  it('rejects record with non-null confidence', () => {
    const rec = validRecord({ id: 'TEST-INTEG-2', confidence: 0.5 as any });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(false);
  });

  it('rejects record with string confidence', () => {
    const rec = validRecord({ id: 'TEST-INTEG-3', confidence: 'high' as any });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(false);
  });
});

// ─── 8. Evidence field integrity ────────────────────────────────────

describe('Evidence field integrity', () => {
  it('requires campo_fuente', () => {
    const rec = validRecord({
      id: 'TEST-EVID-1',
      evidencia: { campo_fuente: '' } as any,
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(false);
  });

  it('accepts valid evidencia', () => {
    const rec = validRecord({
      id: 'TEST-EVID-2',
      evidencia: {
        campo_fuente: 'DT_AWARD',
        url: 'https://example.com',
        observed_at: '2024-06-15',
      },
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(true);
  });

  it('rejects invalid observed_at date', () => {
    const rec = validRecord({
      id: 'TEST-EVID-3',
      evidencia: {
        campo_fuente: 'DT_AWARD',
        observed_at: 'not-a-date',
      } as any,
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    expect(result.success).toBe(false);
  });
});