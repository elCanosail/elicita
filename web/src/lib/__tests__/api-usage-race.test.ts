/**
 * Tarea 37 — Cuota diaria free: carrera check-then-act y consumo atómico.
 *
 * Complemento de INTEGRACIÓN de api-usage.test.ts (que cubre la lógica con
 * queryWrite mockeado): aquí los statements corren contra una web-state real
 * en tmp, para probar la atomicidad real del UPSERT con guard + RETURNING y
 * el comportamiento del ensureUsageTables (índices únicos) sobre el DDL
 * exacto de producción.
 *
 * Cubre el mecanismo completo (propuestas-2026-10-13-1600, B):
 *  1. BUG persistencia: producción creó api_usage_daily/monthly SIN restricción
 *     única → el `ON CONFLICT` de los incrementos fallaba (Binder Error) y el
 *     uso no se persistía. ensureUsageTables() crea los índices únicos de forma
 *     idempotente al primer uso del módulo.
 *  2. BUG carrera: el flujo viejo (SELECT → búsqueda → UPSERT) deja pasar a
 *     TODAS las peticiones que entran a la vez (todas leen count=0). El test
 *     del antipatrón fija ese escape para que el harness demuestre que
 *     detecta la carrera (no vacuamente verde).
 *  3. FIX: consumeDailySearch consume en UN statement (UPSERT con guard
 *     `WHERE search_count < límite` + RETURNING) → exactamente `límite`
 *     peticiones pasan entre N concurrentes.
 *
 * Aislamiento: fixture web-state en tmp vía DUCKDB_WEB_STATE_PATH antes del
 * import (patrón del test de integración). La base principal nunca se abre:
 * el módulo solo toca web-state por queryWrite.
 */
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir = '';
let apiUsage: typeof import('../api-usage');
let queryWrite: typeof import('../duckdb-write').queryWrite;

const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'elicita-api-usage-race-'));
  process.env.DUCKDB_WEB_STATE_PATH = join(tmpDir, 'web-state.duckdb');
  // DDL idéntico al de producción (sin restricción única — ese es el estado
  // real que ensureUsageTables debe reparar al primer uso).
  queryWrite = (await import('../duckdb-write')).queryWrite;
  await queryWrite(
    'CREATE TABLE IF NOT EXISTS api_usage_daily(user_id VARCHAR, date VARCHAR, search_count INTEGER)'
  );
  await queryWrite(
    'CREATE TABLE IF NOT EXISTS api_usage_monthly(user_id VARCHAR, month VARCHAR, queries_used INTEGER, last_updated TIMESTAMP)'
  );
  apiUsage = await import('../api-usage');
  // Primer consume: dispara ensureUsageTables (índices únicos) sobre el fixture.
  const first = await apiUsage.consumeDailySearch('setup-user');
  expect(first.allowed).toBe(true);
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('carrera de la cuota diaria free (tarea 37, BD real)', () => {
  it('ANTIPATRÓN check-then-act: 6 concurrentes pasan TODAS (escape documentado)', async () => {
    // Flujo viejo tal como estaba en api/search.ts hasta la tarea 37:
    // SELECT count → (búsqueda, segundos) → UPSERT +1. La espera de 10ms
    // simula la ventana de carrera: los 6 SELECT completan antes del primer
    // UPSERT, todos ven 0 y todos pasan el guard.
    const user = 'u-antipatron';
    const oldFlow = async (): Promise<boolean> => {
      const rows = await queryWrite(
        'SELECT search_count FROM api_usage_daily WHERE user_id = ? AND date = ?',
        [user, today]
      );
      const count = Number(rows[0]?.search_count || 0);
      if (count >= 3) return false;
      await new Promise((r) => setTimeout(r, 10));
      await queryWrite(
        `INSERT INTO api_usage_daily (user_id, date, search_count)
         VALUES (?, ?, 1)
         ON CONFLICT (user_id, date)
         DO UPDATE SET search_count = search_count + 1`,
        [user, today]
      );
      return true;
    };

    const results = await Promise.all(Array.from({ length: 6 }, () => oldFlow()));
    const allowed = results.filter(Boolean).length;
    const finalRows = await queryWrite(
      'SELECT search_count FROM api_usage_daily WHERE user_id = ? AND date = ?',
      [user, today]
    );
    const finalCount = Number(finalRows[0]?.search_count || 0);

    expect(allowed).toBe(6); // escape: el límite era 3
    expect(finalCount).toBe(6); // y el contador lo registra
    expect(finalCount).toBeGreaterThan(3);
  });

  it('consumeDailySearch es atómico: exactamente 3 de 6 concurrentes pasan', async () => {
    const user = 'u-atomico';
    const results = await Promise.all(
      Array.from({ length: 6 }, () => apiUsage.consumeDailySearch(user))
    );
    const allowed = results.filter((r) => r.allowed);
    const blocked = results.filter((r) => !r.allowed);

    expect(allowed.length).toBe(3);
    expect(blocked.length).toBe(3);
    // remaining coherente con el orden de consumo (2, 1, 0 en algún orden)
    expect(allowed.map((r) => r.remaining).sort().reverse()).toEqual([2, 1, 0]);
    expect(blocked.every((r) => r.remaining === 0 && r.limit === 3)).toBe(true);
    expect(allowed.every((r) => r.limit === 3)).toBe(true);

    const finalRows = await queryWrite(
      'SELECT search_count FROM api_usage_daily WHERE user_id = ? AND date = ?',
      [user, today]
    );
    expect(Number(finalRows[0]?.search_count)).toBe(3); // ni una más
  });

  it('cupo agotado bloquea al 4º consumo secuencial; otro usuario pasa el mismo día', async () => {
    // Autocontenido (sin depender del estado del test anterior): 3 consumos
    // secuenciales agotan el cupo, el 4º y 5º quedan bloqueados.
    const user = 'u-agotado';
    const seq = [];
    for (let i = 0; i < 3; i++) seq.push(await apiUsage.consumeDailySearch(user));
    expect(seq.every((r) => r.allowed)).toBe(true);
    expect(seq.map((r) => r.remaining)).toEqual([2, 1, 0]);

    const blocked = await apiUsage.consumeDailySearch(user);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    const blockedAgain = await apiUsage.consumeDailySearch(user);
    expect(blockedAgain.allowed).toBe(false);

    // El contador no creció pese a los intentos bloqueados
    const finalRows = await queryWrite(
      'SELECT search_count FROM api_usage_daily WHERE user_id = ? AND date = ?',
      [user, today]
    );
    expect(Number(finalRows[0]?.search_count)).toBe(3);

    // Otro usuario tiene su propio contador el mismo día
    const other = await apiUsage.consumeDailySearch('u-otro');
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(2); // su propio contador (1 de 3)
  });

  it('incrementQueryCount (mensual) persiste con el índice único creado', async () => {
    // Antes de la tarea 37 este UPSERT lanzaba Binder Error en producción
    // (tabla sin restricción única) — el uso mensual de la API no se persistía.
    await apiUsage.incrementQueryCount('u-mensual');
    await apiUsage.incrementQueryCount('u-mensual');
    const rows = await queryWrite(
      'SELECT queries_used FROM api_usage_monthly WHERE user_id = ?',
      ['u-mensual']
    );
    expect(Number(rows[0]?.queries_used)).toBe(2);
  });
});
