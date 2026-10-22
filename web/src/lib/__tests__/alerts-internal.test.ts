/**
 * Tests de regresión de /api/v1/alerts-internal — tarea 45.
 *
 * Bug de producción (22-09 → 19-10): el módulo importaba solo `queryState`
 * de lib/duckdb y el camino action=search llamaba `query(sql, p)` →
 * ReferenceError → 500 en toda búsqueda (el único alerta activo llevaba
 * ~24 días sin emails). Estos tests mockean lib/duckdb e importan la ruta
 * tal cual: si `query` vuelve a faltar, el test de search falla.
 *
 * Cubre:
 * - action=search&nif → 200 vía `query` con SQL/params correctos
 * - action=search sin filtros → 400
 * - action=list (default) → 200 vía `queryState`
 * - LOCAL_ONLY → 403 con x-forwarded-for externa
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockQueryState = vi.fn();

vi.mock('../../lib/duckdb', () => ({
  queryState: (...args: any[]) => mockQueryState(...args),
  query: (...args: any[]) => mockQuery(...args),
}));

// Import tras el mock — la ruta es un módulo TS plano (APIRoute).
// @ts-expect-error: import de una ruta Astro fuera del pipeline de Astro
import { GET } from '../../pages/api/v1/alerts-internal';

function ctxFor(urlStr: string, headers: Record<string, string> = {}) {
  const request = new Request(urlStr, { headers });
  const url = new URL(urlStr);
  return { request, url };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryState.mockResolvedValue([]);
  mockQuery.mockResolvedValue([]);
});

describe('GET /api/v1/alerts-internal', () => {
  it('action=search&nif → 200 vía query (regresión del import, tarea 45)', async () => {
    mockQuery.mockResolvedValue([
      { objeto: 'Obra de prueba', importe: 1000, fecha_publicacion: '2026-10-01' },
    ]);

    const ctx = ctxFor('http://localhost/api/v1/alerts-internal?action=search&nif=A28389484');
    const res = await GET(ctx as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.count).toBe(1);
    expect(body.contracts[0].objeto).toBe('Obra de prueba');
    // El camino search usa query; queryState solo el CREATE TABLE de guardia
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('FROM calidad');
    expect(sql).toContain('nif_adjudicatario = ?');
    expect(sql).toContain('ORDER BY fecha_publicacion DESC LIMIT 50');
    expect(params).toEqual(['2026-01-01', 'A28389484']);
  });

  it('action=search con since → 200 y param since respetado', async () => {
    const ctx = ctxFor(
      'http://localhost/api/v1/alerts-internal?action=search&nif=A28389484&since=2026-08-24',
    );
    const res = await GET(ctx as any);
    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[0][1][0]).toBe('2026-08-24');
  });

  it('action=search con cpv → LIKE con prefijo', async () => {
    const ctx = ctxFor(
      'http://localhost/api/v1/alerts-internal?action=search&cpv=33140000',
    );
    const res = await GET(ctx as any);
    expect(res.status).toBe(200);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('CAST(cpv_principal AS VARCHAR) LIKE ?');
    expect(params).toEqual(['2026-01-01', '33140000%']);
  });

  it('action=search sin filtros → 400', async () => {
    const ctx = ctxFor('http://localhost/api/v1/alerts-internal?action=search');
    const res = await GET(ctx as any);
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('action=list (default) → 200 vía queryState', async () => {
    mockQueryState.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM alertas')) {
        return [{ id: 'a1', user_id: 'u1', email: 'x@y.z', active: true }];
      }
      return [];
    });

    const ctx = ctxFor('http://localhost/api/v1/alerts-internal');
    const res = await GET(ctx as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.count).toBe(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('LOCAL_ONLY: x-forwarded-for externa → 403 sin tocar la BD', async () => {
    const ctx = ctxFor('http://localhost/api/v1/alerts-internal', {
      'x-forwarded-for': '203.0.113.9',
    });
    const res = await GET(ctx as any);
    expect(res.status).toBe(403);
    expect(mockQueryState).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
