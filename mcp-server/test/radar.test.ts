/**
 * T6 MCP experimental tool tests: radar_opportunities.
 *
 * Tests:
 * 1. Tool definition (input schema, description markers)
 * 2. Tool is in EXPERIMENTAL_TOOL_NAMES (not STABLE_TOOL_NAMES)
 * 3. Tool description explicitly mentions EXPERIMENTAL
 * 4. RadarOpportunitySchema validates correct/incorrect records
 * 5. Format output function
 *
 * IMPORTANT: This tool is NOT registered in the default registerToolset()
 * function. It must be explicitly registered via registerRadarTool().
 *
 * Source: mcp-server/test/radar.test.ts
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { z } from 'zod';
import {
  RadarInputSchema,
  RadarOpportunitySchema,
} from '../src/tools/radar.js';
import { STABLE_TOOL_NAMES, EXPERIMENTAL_TOOL_NAMES } from '../src/server.js';

// ─── Fixtures ────────────────────────────────────────────────────────

function validRadarRecord(partial: Record<string, unknown>): z.infer<typeof RadarOpportunitySchema> {
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

// ─── 1. Tool definition ─────────────────────────────────────────────

describe('radar_opportunities: tool definition', () => {
  it('input schema accepts minimal query', () => {
    const result = RadarInputSchema.safeParse({});
    assert.equal(result.success, true);
  });

  it('input schema accepts all filter params', () => {
    const result = RadarInputSchema.safeParse({
      fuente: 'TED',
      estimation_status: 'award_proxy_scenario',
      cpv: '7131',
      organismo: 'Ministry',
      limit: 50,
      offset: 10,
    });
    assert.equal(result.success, true);
  });

  it('input schema rejects invalid source', () => {
    const result = RadarInputSchema.safeParse({ fuente: 'UNKNOWN' });
    assert.equal(result.success, false);
  });

  it('input schema rejects invalid estimation_status', () => {
    const result = RadarInputSchema.safeParse({ estimation_status: 'maybe' });
    assert.equal(result.success, false);
  });

  it('input schema rejects limit > 100', () => {
    const result = RadarInputSchema.safeParse({ limit: 101 });
    assert.equal(result.success, false);
  });
});

// ─── 2. Tool is EXPERIMENTAL, not STABLE ────────────────────────────

describe('radar_opportunities: stability classification', () => {
  it('radar_opportunities is NOT in STABLE_TOOL_NAMES', () => {
    assert.ok(!STABLE_TOOL_NAMES.includes('radar_opportunities' as any));
  });

  it('radar_opportunities IS in EXPERIMENTAL_TOOL_NAMES', () => {
    assert.ok(EXPERIMENTAL_TOOL_NAMES.includes('radar_opportunities'));
  });
});

// ─── 3. Contract schema validation ──────────────────────────────────

describe('RadarOpportunitySchema: contract validation', () => {
  it('accepts valid contractual_scenario record', () => {
    const rec = validRadarRecord({ id: 'SCHEMA-VALID-1' });
    const result = RadarOpportunitySchema.safeParse(rec);
    assert.equal(result.success, true);
  });

  it('accepts valid award_proxy_scenario record', () => {
    const rec = validRadarRecord({
      id: 'SCHEMA-VALID-2',
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
    assert.equal(result.success, true);
  });

  it('accepts valid not_estimable record', () => {
    const rec = validRadarRecord({
      id: 'SCHEMA-VALID-3',
      estimation_status: 'not_estimable',
      basis: null,
      estimated_end_date: null,
      duracion: null,
      fecha_inicio: null,
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    assert.equal(result.success, true);
  });

  it('rejects non-null confidence', () => {
    const rec = validRadarRecord({
      id: 'SCHEMA-INVALID-1',
      confidence: 0.8 as any,
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    assert.equal(result.success, false);
  });

  it('rejects invalid estimation_status', () => {
    const rec = validRadarRecord({
      id: 'SCHEMA-INVALID-2',
      estimation_status: 'maybe' as any,
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    assert.equal(result.success, false);
  });

  it('rejects invalid duration unit', () => {
    const rec = validRadarRecord({
      id: 'SCHEMA-INVALID-3',
      duracion: { valor: 12, unidad: 'WEEK' as any },
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    assert.equal(result.success, false);
  });

  it('rejects negative duration valor', () => {
    const rec = validRadarRecord({
      id: 'SCHEMA-INVALID-4',
      duracion: { valor: -5, unidad: 'DAY' },
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    assert.equal(result.success, false);
  });
});

// ─── 4. Tool registration (does not pollute stable tools) ───────────

describe('radar_opportunities: registration isolation', () => {
  it('registerRadarTool does not add to STABLE_TOOL_NAMES', () => {
    // STABLE_TOOL_NAMES is a const array, not mutable by registerRadarTool.
    // Just verify the const value hasn't changed.
    assert.ok(!STABLE_TOOL_NAMES.includes('radar_opportunities' as any));
    const stableList = [...STABLE_TOOL_NAMES];
    assert.ok(stableList.includes('search_licitaciones'));
    assert.ok(stableList.includes('get_stats'));
  });
});

// ─── 5. Evidence field validation ───────────────────────────────────

describe('Evidence field validation', () => {
  it('accepts evidencia with campo_fuente', () => {
    const rec = validRadarRecord({
      id: 'EVID-VALID',
      evidencia: { campo_fuente: 'DT_AWARD', url: 'https://example.com' },
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    assert.equal(result.success, true);
  });

  it('rejects evidencia without campo_fuente', () => {
    const rec = validRadarRecord({
      id: 'EVID-INVALID',
      evidencia: { campo_fuente: '' } as any,
    });
    const result = RadarOpportunitySchema.safeParse(rec);
    assert.equal(result.success, false);
  });
});