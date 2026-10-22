/**
 * Tests for JEV re-ranking (smart search flag) — see
 * docs/plans/track-jev-buscador-spike.md for the design rules:
 * relative re-ranking (never an absolute gate) and fail-open behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { applyRerank, detectNoClearMatch, jevRerank, jevRerankEnabled } from '../jev-rerank';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.ELICITA_JEV_SMART = '1';
  process.env.ELICITA_TYPESAFE_API_KEY = 'k-test';
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.unstubAllGlobals();
});

describe('jevRerankEnabled', () => {
  it('requires both the env flag and an API key', () => {
    expect(jevRerankEnabled()).toBe(true);
    process.env.ELICITA_JEV_SMART = '0';
    expect(jevRerankEnabled()).toBe(false);
    process.env.ELICITA_JEV_SMART = '1';
    delete process.env.ELICITA_TYPESAFE_API_KEY;
    process.env.ELICITA_TYPESAFE_KEY_FILE = '/no/existe/ninguna.key';
    expect(jevRerankEnabled()).toBe(false);
  });

  it('falls back to the protected key file when the env var is absent', () => {
    delete process.env.ELICITA_TYPESAFE_API_KEY;
    process.env.ELICITA_TYPESAFE_KEY_FILE = '/no/existe/ninguna.key';
    expect(jevRerankEnabled()).toBe(false);
    process.env.ELICITA_TYPESAFE_KEY_FILE = '/tmp/jev-test-fallback.key';
    fs.writeFileSync('/tmp/jev-test-fallback.key', 'file-key-123\n');
    expect(jevRerankEnabled()).toBe(true);
    fs.unlinkSync('/tmp/jev-test-fallback.key');
  });
});

describe('applyRerank', () => {
  const cands = [
    { id: 'a', titulo: 'A' },
    { id: 'b', titulo: 'B' },
    { id: 'c', titulo: 'C' },
    { id: 'd', titulo: 'D' },
  ];

  it('orders by JEV score descending', () => {
    expect(applyRerank(cands, { a: 0.1, b: 0.9, c: 0.5, d: 0.3 }).map((c) => c.id)).toEqual([
      'b', 'c', 'd', 'a',
    ]);
  });

  it('breaks ties by original order (stable)', () => {
    expect(applyRerank(cands, { b: 0.9, a: 0.9 }).map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sinks candidates missing from the score map without reordering them among themselves', () => {
    expect(applyRerank(cands, { d: 0.4 }).map((c) => c.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('handles an empty score map (classic order preserved)', () => {
    expect(applyRerank(cands, {}).map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('jevRerank', () => {
  const cands = [
    { id: 'id-1', titulo: 'Suministro de equipos informáticos' },
    { id: 'id-2', titulo: 'Obras de reparación de fachada' },
    { id: 'id-3', titulo: null },
  ];

  it('returns null without calling the API when there are fewer than 2 candidates', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await jevRerank('q', [{ id: 'id-1', titulo: 'x' }])).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('returns null without calling the API when no key is configured', async () => {
    delete process.env.ELICITA_TYPESAFE_API_KEY;
    process.env.ELICITA_TYPESAFE_KEY_FILE = '/no/existe/ninguna.key';
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await jevRerank('q', cands)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('uses the key file as Bearer when the env var is absent', async () => {
    delete process.env.ELICITA_TYPESAFE_API_KEY;
    fs.writeFileSync('/tmp/jev-test-bearer.key', 'file-key-456\n');
    process.env.ELICITA_TYPESAFE_KEY_FILE = '/tmp/jev-test-bearer.key';
    let capturedAuth = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        capturedAuth = init.headers.Authorization;
        return { ok: true, json: async () => ({ answers: {} }) };
      })
    );
    await jevRerank('q', cands);
    expect(capturedAuth).toBe('Bearer file-key-456');
    fs.unlinkSync('/tmp/jev-test-bearer.key');
  });

  it('sends model, state and one noul question per candidate, with title truncated', async () => {
    let capturedBody: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            answers: {
              'id-1': { noul: 0.93 },
              'id-2': { noul: 0.02 },
              'id-3': { noul: 'oops' }, // non-numeric → coerced to 0
            },
          }),
        };
      })
    );
    const longTitle = 'x'.repeat(500);
    const out = await jevRerank('equipos portátiles', [
      { id: 'id-1', titulo: longTitle },
      { id: 'id-2', titulo: 'fachada' },
      { id: 'id-3', titulo: null },
    ]);
    expect(capturedBody.model).toBe('jev-latest');
    expect(capturedBody.state).toContain('equipos portátiles');
    const q1 = capturedBody.questions['id-1'];
    expect(q1.type).toBe('noul');
    expect(q1.instructions.length).toBeLessThanOrEqual(
      'Expediente de licitación pública. Título/objeto: '.length + 300 + '. — ¿Corresponde a lo que el usuario busca?'.length
    );
    expect(q1.criteria).toEqual({
      true: 'Corresponde claramente a la necesidad del usuario',
      false: 'No corresponde a lo buscado',
    });
    expect(out?.scores).toEqual({ 'id-1': 0.93, 'id-2': 0.02, 'id-3': 0 });
    expect(typeof out?.ms).toBe('number');
  });

  it('caps the pool at 25 candidates', async () => {
    let capturedBody: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ answers: {} }) };
      })
    );
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, titulo: `t${i}` }));
    await jevRerank('q', many);
    expect(Object.keys(capturedBody.questions).length).toBe(25);
  });

  it('fails open on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    expect(await jevRerank('q', cands)).toBeNull();
  });

  it('fails open on timeout/network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    expect(await jevRerank('q', cands)).toBeNull();
  });
});

describe('detectNoClearMatch', () => {
  it('flags the junk pool from the eval (LED/embalses, lax pool: 0.04-0.06)', () => {
    expect(
      detectNoClearMatch({ a: 0.06, b: 0.06, c: 0.05, d: 0.05, e: 0.04 })
    ).toBe(true);
  });

  it('flags the junk production pool (pantallas LED: top1 0.67, margin ~0.01)', () => {
    expect(detectNoClearMatch({ a: 0.67, b: 0.66, c: 0.4 })).toBe(true);
  });

  it('flags sparse matches (IA: top1 0.46, margin 0.03) — defensible honest labeling', () => {
    expect(detectNoClearMatch({ a: 0.46, b: 0.43, c: 0.43 })).toBe(true);
  });

  it('does NOT flag the rescued query (puente: top1 0.63, margin 0.19)', () => {
    expect(detectNoClearMatch({ a: 0.63, b: 0.44, c: 0.31 })).toBe(false);
  });

  it('does NOT flag clear matches (residuos 0.90, consumibles 0.85)', () => {
    expect(detectNoClearMatch({ a: 0.9, b: 0.88, c: 0.86 })).toBe(false);
    expect(detectNoClearMatch({ a: 0.85, b: 0.84, c: 0.82 })).toBe(false);
  });

  it('handles edge cases: empty map, single result', () => {
    expect(detectNoClearMatch({})).toBe(false);
    expect(detectNoClearMatch({ a: 0.5 })).toBe(true);
    expect(detectNoClearMatch({ a: 0.9 })).toBe(false);
  });

  it('ignores non-finite scores', () => {
    expect(detectNoClearMatch({ a: Number.NaN, b: 0.9, c: 0.2 })).toBe(false);
  });
});
