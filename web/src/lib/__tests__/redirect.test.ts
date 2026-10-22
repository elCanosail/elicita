/**
 * Tests de lib/redirect.ts — sanitización del parámetro ?redirect=
 * usado por /sign-up y /sign-in (F1.2).
 */

import { describe, expect, it } from 'vitest';
import { sanitizeInternalRedirect } from '../redirect';

describe('sanitizeInternalRedirect', () => {
  it('acepta rutas internas simples', () => {
    expect(sanitizeInternalRedirect('/perfil/B01666666', '/fallback')).toBe('/perfil/B01666666');
    expect(sanitizeInternalRedirect('/cuenta/alertas', '/fallback')).toBe('/cuenta/alertas');
  });

  it('acepta rutas internas con query string', () => {
    expect(sanitizeInternalRedirect('/cuenta/alertas?x=1', '/fallback')).toBe('/cuenta/alertas?x=1');
  });

  it('recorta espacios', () => {
    expect(sanitizeInternalRedirect('  /perfil/A12345678  ', '/fallback')).toBe('/perfil/A12345678');
  });

  it('rechaza protocol-relative (//evil.com)', () => {
    expect(sanitizeInternalRedirect('//evil.com', '/fallback')).toBe('/fallback');
  });

  it('rechaza URLs absolutas con protocolo', () => {
    expect(sanitizeInternalRedirect('https://evil.com/perfil', '/fallback')).toBe('/fallback');
    expect(sanitizeInternalRedirect('javascript:alert(1)', '/fallback')).toBe('/fallback');
  });

  it('rechaza backslashes y rutas sin barra inicial', () => {
    expect(sanitizeInternalRedirect('/\\evil.com', '/fallback')).toBe('/fallback');
    expect(sanitizeInternalRedirect('perfil/B01666666', '/fallback')).toBe('/fallback');
  });

  it('usa el fallback con null/undefined/vacío', () => {
    expect(sanitizeInternalRedirect(null, '/fallback')).toBe('/fallback');
    expect(sanitizeInternalRedirect(undefined, '/fallback')).toBe('/fallback');
    expect(sanitizeInternalRedirect('', '/fallback')).toBe('/fallback');
    expect(sanitizeInternalRedirect('   ', '/fallback')).toBe('/fallback');
  });
});
