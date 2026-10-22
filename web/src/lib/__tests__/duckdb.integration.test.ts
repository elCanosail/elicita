/**
 * Integration tests for web/src/lib/duckdb.ts.
 *
 * La DB de producción está abierta por el web server (conexión RW singleton,
 * DuckDB no permite multi-RW sobre el mismo archivo). Por eso estos tests
 * copian la DB a un path temporal y abren conexión propia sobre la copia.
 *
 * Importante: el módulo duckdb.ts lee DUCKDB_PATH en el import, por eso se
 * importa DINÁMICAMENTE después de setear el env en beforeAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import type * as DuckDbModule from '../duckdb';

const SRC_DB = '/var/data/licitaciones/db/licitaciones.duckdb';

// SKIP por defecto (tarea 14): el beforeAll copia 7,6 GB de la DB de producción
// a /tmp — minutos de IO y el doble de espacio en disco, inasumible en cada
// `npm test` y dependiente de infraestructura externa. Se ejecuta a demanda:
//   RUN_DUCKDB_INTEGRATION=1 npx vitest run src/lib/__tests__/duckdb.integration.test.ts
const RUN_DUCKDB_INTEGRATION = process.env.RUN_DUCKDB_INTEGRATION === '1';
const describeIfRun = RUN_DUCKDB_INTEGRATION ? describe : describe.skip;

let tmpDb = '';
let mod: typeof DuckDbModule;

beforeAll(async () => {
  if (!existsSync(SRC_DB)) {
    throw new Error(`DB no encontrada: ${SRC_DB}`);
  }
  tmpDb = join(tmpdir(), `elicita-test-${Date.now()}.duckdb`);
  execSync(`cp "${SRC_DB}" "${tmpDb}"`);
  process.env.DUCKDB_PATH = tmpDb;
  mod = await import('../duckdb');
}, 300000);

afterAll(() => {
  if (mod) mod.closeDuckDB();
  if (tmpDb && existsSync(tmpDb)) {
    try { unlinkSync(tmpDb); } catch { /* best effort */ }
  }
});

describeIfRun('duckdb integración (copia temporal)', () => {
  it('query SELECT 1 devuelve resultado', async () => {
    const rows = await mod.query('SELECT 1 AS uno');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].uno).toBe(1);
  }, 30000);

  it('convierte BigInt a Number', async () => {
    const rows = await mod.query('SELECT CAST(123456789012345 AS BIGINT) AS big');
    expect(typeof rows[0].big).toBe('number');
    expect(rows[0].big).toBe(123456789012345);
  }, 30000);

  it('convierte Date a ISO', async () => {
    const rows = await mod.query("SELECT DATE '2024-06-15' AS d");
    expect(rows[0].d).toBe('2024-06-15');
  }, 30000);

  it('pasa parámetros preparados (? placeholders)', async () => {
    const rows = await mod.query('SELECT ? AS v', ['hola']);
    expect(rows[0].v).toBe('hola');
  }, 30000);

  it('cuenta contratos de la tabla principal (lectura real)', async () => {
    const rows = await mod.query('SELECT COUNT(*) AS total FROM contratos_vivos');
    expect(rows[0].total).toBeGreaterThan(0);
  }, 60000);
});