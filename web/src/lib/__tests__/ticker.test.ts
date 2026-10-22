import { describe, expect, it } from 'vitest';
import { mapTickerRow } from '../ticker';

describe('contrato del ticker público (/api/public/ticker)', () => {
  it('mapea una fila completa de calidad', () => {
    const item = mapTickerRow({
      expediente: 'EXP-2026-01',
      organo_contratante: 'Ayuntamiento de Getafe',
      adjudicatario: 'Tecnología SL',
      importe_adjudicacion: 1234567n,
      fecha_publicacion: '2026-10-01',
    });
    expect(item).toEqual({
      expediente: 'EXP-2026-01',
      organo: 'Ayuntamiento de Getafe',
      adjudicatario: 'Tecnología SL',
      importe: 1234567,
      fecha_publicacion: '2026-10-01',
    });
  });

  it('no expone `fuente` (columna inexistente en calidad — bug 8a77cc9 corregido)', () => {
    const item = mapTickerRow({ expediente: 'X', organo_contratante: 'O', adjudicatario: 'A', importe_adjudicacion: 5 });
    expect('fuente' in item).toBe(false);
    expect(Object.keys(item).sort()).toEqual(['adjudicatario', 'expediente', 'fecha_publicacion', 'importe', 'organo']);
  });

  it('tolera nulos y bigints', () => {
    const item = mapTickerRow({
      expediente: null,
      organo_contratante: null,
      adjudicatario: null,
      importe_adjudicacion: 987654321n,
      fecha_publicacion: null,
    });
    expect(item.expediente).toBe('');
    expect(item.organo).toBe('');
    expect(item.adjudicatario).toBe('');
    expect(item.importe).toBe(987654321);
    expect(item.fecha_publicacion).toBeNull();
  });
});
