import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheClear, cacheGet, cacheSet, cacheSize, cached, cachedResponse } from '../cache';

describe('lib/cache', () => {
  beforeEach(() => {
    cacheClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('miss → computa → hit no re-computa', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return { n: 42 };
    };
    expect(await cached('k1', 60_000, fn)).toEqual({ n: 42 });
    expect(await cached('k1', 60_000, fn)).toEqual({ n: 42 });
    expect(calls).toBe(1);
  });

  it('claves distintas no colisionan (clave por query)', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };
    expect(await cached('q=a', 60_000, fn)).toBe(1);
    expect(await cached('q=b', 60_000, fn)).toBe(2);
    expect(await cached('q=a', 60_000, fn)).toBe(1);
    expect(calls).toBe(2);
  });

  it('expira por TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };
    await cached('ttl', 5_000, fn);
    vi.setSystemTime(new Date('2026-10-12T12:00:04Z'));
    await cached('ttl', 5_000, fn); // dentro del TTL
    expect(calls).toBe(1);
    vi.setSystemTime(new Date('2026-10-12T12:00:06Z'));
    await cached('ttl', 5_000, fn); // expirado
    expect(calls).toBe(2);
  });

  it('mapa acotado: LRU expulsa la entrada más vieja no refrescada', () => {
    for (let i = 0; i < 128; i++) cacheSet(`k${i}`, i, 60_000);
    cacheGet('k0'); // refresca la recencia de la más vieja
    cacheSet('kNUEVA', 'v', 60_000); // fuerza expulsión → k1
    expect(cacheGet('k0')).toBe(0); // sobrevive (refrescada)
    expect(cacheGet('k1')).toBeUndefined(); // expulsada
    expect(cacheGet('kNUEVA')).toBe('v');
    expect(cacheSize()).toBe(128);
  });

  it('un error de fn no se cachea', async () => {
    let calls = 0;
    const bad = async () => {
      calls++;
      throw new Error('boom');
    };
    await expect(cached('err', 60_000, bad)).rejects.toThrow('boom');
    await expect(cached('err', 60_000, bad)).rejects.toThrow('boom');
    expect(calls).toBe(2);
    expect(cacheGet('err')).toBeUndefined();
  });

  it('cachedResponse: byte-idéntico en hit y solo cachea 2xx', async () => {
    const make = (status: number) =>
      new Response(JSON.stringify({ ok: status === 200 }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
      });
    let calls = 0;
    const fn = async () => {
      calls++;
      return make(200);
    };
    const r1 = await cachedResponse('resp', 60_000, fn);
    const r2 = await cachedResponse('resp', 60_000, fn);
    expect(await r1.text()).toBe(await r2.text());
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(calls).toBe(1);

    let calls404 = 0;
    const fn404 = async () => {
      calls404++;
      return make(404);
    };
    const n1 = await cachedResponse('resp404', 60_000, fn404);
    const n2 = await cachedResponse('resp404', 60_000, fn404);
    expect(n1.status).toBe(404);
    expect(n2.status).toBe(404);
    expect(calls404).toBe(2); // el 404 no se cachea
  });
});
