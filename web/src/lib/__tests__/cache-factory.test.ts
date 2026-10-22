import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheSet, cacheSize, createMemoCache } from '../cache';

// El store por defecto (LRU 128) queda intocado por las instancias del factory
// y viceversa — los tests del factory no deben contaminar a otros suites.
afterEach(() => {
  vi.useRealTimers();
});

describe('createMemoCache (tarea 40 — escudo SSR, capacidad parametrizable)', () => {
  it('expulsa por LRU al superar SU capacidad (no la fija de 128)', () => {
    const c = createMemoCache(3);
    c.set('k1', 'v1', 60_000);
    c.set('k2', 'v2', 60_000);
    c.set('k3', 'v3', 60_000);
    expect(c.size()).toBe(3);
    c.set('k4', 'v4', 60_000); // k1 es la menos reciente → fuera
    expect(c.size()).toBe(3);
    expect(c.get('k1')).toBeUndefined();
    expect(c.get('k2')).toBe('v2');
    expect(c.get('k4')).toBe('v4');
    // Recencia: re-leer k2 la protege de la siguiente expulsión
    c.get('k2');
    c.set('k5', 'v5', 60_000);
    expect(c.get('k2')).toBe('v2');
    expect(c.get('k3')).toBeUndefined();
  });

  it('expira por TTL (miss tras expires)', () => {
    vi.useFakeTimers();
    const c = createMemoCache(10);
    c.set('k', 'v', 300);
    expect(c.get('k')).toBe('v');
    vi.advanceTimersByTime(301);
    expect(c.get('k')).toBeUndefined();
    expect(c.size()).toBe(0); // la entrada caducada se purga al leer
  });

  it('cached() computa una sola vez dentro del TTL y devuelve el valor cacheado', async () => {
    vi.useFakeTimers();
    const c = createMemoCache(10);
    let computes = 0;
    const fn = async () => {
      computes += 1;
      return { dato: computes };
    };
    const first = await c.cached('clave', 300, fn);
    vi.advanceTimersByTime(100);
    const second = await c.cached('clave', 300, fn);
    expect(computes).toBe(1);
    expect(second).toBe(first);
    expect(second).toEqual({ dato: 1 });
  });

  it('cached() NO cachea cuando fn lanza (guarda de errores — solo éxitos)', async () => {
    const c = createMemoCache(10);
    await expect(c.cached('mala', 300, async () => { throw new Error('duckdb down'); })).rejects.toThrow();
    expect(c.size()).toBe(0);
    // Tras el fallo, un reintento que funciona se cachea normal
    const v = await c.cached('mala', 300, async () => 'ok');
    expect(v).toBe('ok');
    expect(c.size()).toBe(1);
  });

  it('claves aisladas entre instancias y del store por defecto', async () => {
    const ficha = createMemoCache(10_000);
    const perfil = createMemoCache(500);
    const ccaa = createMemoCache(32);
    await ficha.cached('fuente|id', 60_000, async () => 'fila-ficha');
    await perfil.cached('fuente|id', 60_000, async () => 'agregados-perfil');
    await ccaa.cached('fuente|id', 60_000, async () => 'listado-ccaa');
    expect(ficha.get('fuente|id')).toBe('fila-ficha');
    expect(perfil.get('fuente|id')).toBe('agregados-perfil');
    expect(ccaa.get('fuente|id')).toBe('listado-ccaa');
    // El store por defecto (APIs, tareas 29/32) no ve claves de las instancias
    cacheSet('fuente|id', 'default', 60_000);
    expect(ficha.get('fuente|id')).toBe('fila-ficha');
    expect(cacheSize()).toBeGreaterThanOrEqual(1);
    ficha.clear();
    expect(ficha.size()).toBe(0);
    expect(perfil.size()).toBe(1);
  });
});
