import { describe, expect, it } from 'vitest';
import { normalizeCpv } from '../cpv';

describe('normalizeCpv (semántica prefijo)', () => {
  it('forma completa de 8 dígitos → familia sin ceros finales', () => {
    expect(normalizeCpv('33140000')).toBe('3314');
  });

  it('formato con puntos "3314.00.00" → "3314"', () => {
    expect(normalizeCpv('3314.00.00')).toBe('3314');
  });

  it('formato decimal "33140000.0" → "3314"', () => {
    expect(normalizeCpv('33140000.0')).toBe('3314');
  });

  it('forma ya canónica pasa intacta', () => {
    expect(normalizeCpv('3314')).toBe('3314');
  });

  it('con espacios alrededor → trim', () => {
    expect(normalizeCpv('  3314 ')).toBe('3314');
  });

  it('dígito único "7" sigue siendo válido (división entera)', () => {
    expect(normalizeCpv('7')).toBe('7');
  });

  it('solo ceros "0000" → null (no hay familia que capturar)', () => {
    expect(normalizeCpv('0000')).toBeNull();
  });

  it('no numérico → null', () => {
    expect(normalizeCpv('abc')).toBeNull();
    expect(normalizeCpv('33a4')).toBeNull();
  });

  it('vacío y null → null', () => {
    expect(normalizeCpv('')).toBeNull();
    expect(normalizeCpv(null)).toBeNull();
    expect(normalizeCpv(undefined)).toBeNull();
  });
});
