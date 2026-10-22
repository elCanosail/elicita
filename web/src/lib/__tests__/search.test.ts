/**
 * Tests for buildUnionQuery (T2a — sort allowlist fix).
 *
 * Isolated DuckDB in-memory database: never touches the prod DB.
 * Fixture tables mimic the _json tables that buildUnionQuery UNIONs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { buildUnionQuery, buildSearchTerms } from '../search';

/* ------------------------------------------------------------------ */
/*  Helpers: promisify DuckDB callbacks                                */
/* ------------------------------------------------------------------ */
function run(db: duckdb.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function exec(db: duckdb.Database, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: unknown, rows: any[]) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function bigIntSafe(rows: any[]): any[] {
  return rows.map((row: any) => {
    const out: any = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    return out;
  });
}

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

describe('buildUnionQuery sort fix (T2a)', () => {
  describe('SQL generation', () => {
    it('generates ORDER BY using projected alias "fecha"', () => {
      const q = buildUnionQuery('', { sort: 'fecha' });
      expect(q.dataSql).toContain('ORDER BY fecha DESC NULLS LAST');
    });

    it('generates ORDER BY using projected alias "titulo"', () => {
      const q = buildUnionQuery('', { sort: 'titulo' });
      expect(q.dataSql).toContain('ORDER BY titulo DESC NULLS LAST');
    });

    it('generates ORDER BY using projected alias "organismo"', () => {
      const q = buildUnionQuery('', { sort: 'organismo' });
      expect(q.dataSql).toContain('ORDER BY organismo DESC NULLS LAST');
    });

    it('generates ORDER BY using projected alias "importe"', () => {
      const q = buildUnionQuery('', { sort: 'importe' });
      expect(q.dataSql).toContain('ORDER BY importe DESC NULLS LAST');
    });

    it('generates ORDER BY using projected alias "adjudicatario"', () => {
      const q = buildUnionQuery('', { sort: 'adjudicatario' });
      expect(q.dataSql).toContain('ORDER BY adjudicatario DESC NULLS LAST');
    });

    it('generates ORDER BY using projected alias "fuente"', () => {
      const q = buildUnionQuery('', { sort: 'fuente' });
      expect(q.dataSql).toContain('ORDER BY fuente DESC NULLS LAST');
    });

    it('defaults to fecha when sort is empty string', () => {
      const q = buildUnionQuery('', { sort: '' });
      expect(q.dataSql).toContain('ORDER BY fecha DESC NULLS LAST');
    });

    it('defaults to fecha when sort key is unknown', () => {
      const q = buildUnionQuery('', { sort: 'campo_inexistente' });
      expect(q.dataSql).toContain('ORDER BY fecha DESC NULLS LAST');
    });

    it('respects dir=asc', () => {
      const q = buildUnionQuery('', { sort: 'fecha', dir: 'asc' });
      expect(q.dataSql).toContain('ORDER BY fecha ASC NULLS FIRST');
    });

    it('respects dir=desc (default)', () => {
      const q = buildUnionQuery('', { sort: 'fecha', dir: 'desc' });
      expect(q.dataSql).toContain('ORDER BY fecha DESC NULLS LAST');
    });

    it('escapes malicious sort values — falls back to default', () => {
      const q = buildUnionQuery('', { sort: "'; DROP TABLE fixture; --" });
      // Malicious value falls through to default; safe because not interpolated as-is
      expect(q.dataSql).toContain('ORDER BY fecha DESC NULLS LAST');
      expect(q.dataSql).not.toContain('DROP');
    });

    it('does not treat prototype keys as sortable columns (SQL generation)', () => {
      for (const key of ['__proto__', 'constructor', 'toString']) {
        const q = buildUnionQuery('', { sort: key });
        expect(q.dataSql).toContain('ORDER BY fecha DESC NULLS LAST');
        expect(q.dataSql).not.toContain('__proto__');
        expect(q.dataSql).not.toContain('constructor');
        expect(q.dataSql).not.toContain('toString');
      }
    });
  });

  describe('SQL execution against in-memory DuckDB', () => {
    let db: duckdb.Database;

    beforeAll(async () => {
      db = new duckdb.Database(':memory:');
      // buildUnionQuery lee la tabla materializada `contratos_busqueda`
      // (2026-09-26: une la ventana viva con el histórico PLACSP).
      await run(db, `
        CREATE TABLE contratos_busqueda (
          id VARCHAR, fuente VARCHAR, expediente VARCHAR, organismo VARCHAR,
          objeto VARCHAR, cpv VARCHAR, cpvs VARCHAR,
          importe_licitacion DOUBLE, importe_adjudicacion DOUBLE,
          fecha_publicacion DATE, fecha_fin DATE, url VARCHAR,
          estado VARCHAR, adjudicatario VARCHAR, nif_adjudicatario VARCHAR
        )
      `);
      await run(db, `
        INSERT INTO contratos_busqueda VALUES
          ('c1','PLACE','EXP-001','Organismo A','Producto X','07300000',null,
           100000, 95000, DATE '2024-01-15', DATE '2024-12-31',
           'http://a.es', 'publicada', 'Proveedor 1', 'A1111111A'),
          ('c2','TED','EXP-002','Organismo B','Servicio Z','07400000',null,
           250000, 240000, DATE '2024-06-01', NULL,
           'http://b.es', 'adjudicada', 'Proveedor 2', 'B2222222B'),
          ('c3','PLACE','EXP-003','Organismo A',null,'07500000',null,
           50000, 0, DATE '2024-03-10', DATE '2024-06-30',
           'http://c.es', 'en proceso', 'Proveedor 1', 'A1111111A')
      `);
    });

    afterAll(() => {
      db.close();
    });

    function runQuery(filters: Record<string, string>): Promise<any[]> {
      const q = buildUnionQuery('', filters);
      return exec(db, q.dataSql).then(bigIntSafe);
    }

    it('sorts by fecha DESC — latest first: c2(Jun) → c3(Mar) → c1(Jan)', async () => {
      const rows = await runQuery({ sort: 'fecha' });
      expect(rows.length).toBe(3);
      expect(rows[0].id).toBe('c2'); // 2024-06-01 (latest first)
      expect(rows[1].id).toBe('c3'); // 2024-03-10
      expect(rows[2].id).toBe('c1'); // 2024-01-15
    });

    it('sorts by fecha ASC — earliest first: c1(Jan) → c3(Mar) → c2(Jun)', async () => {
      const rows = await runQuery({ sort: 'fecha', dir: 'asc' });
      expect(rows.length).toBe(3);
      expect(rows[0].id).toBe('c1'); // 2024-01-15 (earliest first in ASC)
      expect(rows[1].id).toBe('c3'); // 2024-03-10
      expect(rows[2].id).toBe('c2'); // 2024-06-01
    });

    it('sorts by titulo ASC — nulls first in ASC', async () => {
      const rows = await runQuery({ sort: 'titulo', dir: 'asc' });
      expect(rows.length).toBe(3);
      // c3 has NULL objeto → NULLS FIRST in ASC
      expect(rows[0].id).toBe('c3');
      expect(rows[1].id).toBe('c1'); // Producto X
      expect(rows[2].id).toBe('c2'); // Servicio Z
    });

    it('sorts by titulo DESC — nulls last in DESC', async () => {
      const rows = await runQuery({ sort: 'titulo', dir: 'desc' });
      expect(rows.length).toBe(3);
      // c3 has NULL objeto → NULLS LAST in DESC
      expect(rows[0].id).toBe('c2'); // Servicio Z
      expect(rows[1].id).toBe('c1'); // Producto X
      expect(rows[2].id).toBe('c3'); // NULL
    });

    it('sorts by importe DESC — highest first', async () => {
      const rows = await runQuery({ sort: 'importe', dir: 'desc' });
      expect(rows.length).toBe(3);
      // importe = COALESCE(importe_adjudicacion, importe_licitacion)
      // c2: 240000, c1: 95000, c3: 0
      expect(rows[0].id).toBe('c2');
      expect(rows[1].id).toBe('c1');
      expect(rows[2].id).toBe('c3');
    });

    it('sorts by organismo ASC — deterministic tie-break on id', async () => {
      const rows = await runQuery({ sort: 'organismo', dir: 'asc' });
      expect(rows.length).toBe(3);
      // c1 and c3 are Organismo A, c2 is Organismo B.
      // Within the same organismo the tie-break is fuente ASC, id ASC
      // (not DuckDB insertion order), so c1 precedes c3.
      expect(rows[0].id).toBe('c1'); // Organismo A
      expect(rows[1].id).toBe('c3'); // Organismo A (tied, broken by id ASC)
      expect(rows[2].id).toBe('c2'); // Organismo B
    });

    it('sorts by adjudicatario ASC — deterministic tie-break on id', async () => {
      const rows = await runQuery({ sort: 'adjudicatario', dir: 'asc' });
      expect(rows.length).toBe(3);
      // c1 and c3 are Proveedor 1, c2 is Proveedor 2.
      // Tie-break is fuente ASC, id ASC, so c1 precedes c3.
      expect(rows[0].id).toBe('c1'); // Proveedor 1
      expect(rows[1].id).toBe('c3'); // Proveedor 1 (tied, broken by id ASC)
      expect(rows[2].id).toBe('c2'); // Proveedor 2
    });

    it('paginación: limit=2 adds +1 to detect hasMore', async () => {
      const q = buildUnionQuery('', { sort: 'fecha', limit: '2' });
      expect(q.dataSql).toContain('LIMIT 3 OFFSET 0');
    });

    it('paginación con offset', async () => {
      const q = buildUnionQuery('', { sort: 'fecha', limit: '2', offset: '2' });
      expect(q.dataSql).toContain('LIMIT 3 OFFSET 2');
    });

    it('unknown sort falls back to fecha — executes without error', async () => {
      const q = buildUnionQuery('', { sort: 'campo_que_no_existe' });
      const rows = await exec(db, q.dataSql).then(bigIntSafe);
      expect(rows.length).toBe(3);
    });

    it('malicious sort value does not inject SQL — executes safely', async () => {
      const q = buildUnionQuery('', { sort: "'; SELECT 1; --" });
      const rows = await exec(db, q.dataSql).then(bigIntSafe);
      expect(rows.length).toBe(3);
    });

    // Security: prototype keys must NOT resolve to sortable columns.
    // A plain object literal allowlist would return Object.prototype for
    // '__proto__' (truthy) and interpolate it into the ORDER BY. With a
    // null-prototype object these all fall through to the default 'fecha'.
    it('prototype keys (__proto__, constructor, toString) fall back to fecha', () => {
      for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
        const q = buildUnionQuery('', { sort: key });
        expect(q.dataSql).toContain('ORDER BY fecha DESC NULLS LAST');
        expect(q.dataSql).not.toContain(key);
      }
    });

    it('prototype sort keys execute safely (no inherited-column interpolation)', async () => {
      for (const key of ['__proto__', 'constructor', 'toString']) {
        const q = buildUnionQuery('', { sort: key });
        const rows = await exec(db, q.dataSql).then(bigIntSafe);
        expect(rows.length).toBe(3);
      }
    });

    it('generates deterministic tie-break on fuente, id', () => {
      const q = buildUnionQuery('', { sort: 'fecha' });
      expect(q.dataSql).toContain('ORDER BY fecha DESC NULLS LAST, fuente ASC, id ASC');
    });

    it('sort by fuente DESC — TED > PLACE lexicographically DESC', async () => {
      const rows = await runQuery({ sort: 'fuente', dir: 'desc' });
      expect(rows.length).toBe(3);
      // c2 has TED, c1 and c3 have PLACE. DESC: TED before PLACE.
      expect(rows[0].id).toBe('c2'); // TED (comes first in DESC)
      expect(rows[1].id).toBe('c1'); // PLACE (tied)
      expect(rows[2].id).toBe('c3'); // PLACE (tied, stable)
    });

    it('text search with sort: "Producto" matches c1 only', async () => {
      const q = buildUnionQuery('Producto', { sort: 'titulo' });
      const rows = await exec(db, q.dataSql).then(bigIntSafe);
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe('c1');
    });
  });
});

/* ================================================================== */
/*  Tokenized lax search (buscador v2 — spike JEV 2026-09-20)          */
/* ================================================================== */

describe('tokenized lax search (buscador v2)', () => {
  describe('buildSearchTerms', () => {
    it('lowercases, splits and drops words under 3 chars', () => {
      expect(buildSearchTerms('Gestión de Residuos tóxicos')).toEqual(['gestión', 'residuos', 'tóxicos']);
    });

    it('dedupes and caps at 8 terms', () => {
      const nine = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj';
      expect(buildSearchTerms(nine).length).toBe(8);
      expect(buildSearchTerms('luces led luces presas')).toEqual(['luces', 'led', 'presas']);
    });

    it('quoted phrase stays a single exact term', () => {
      expect(buildSearchTerms('"equipos informáticos"')).toEqual(['equipos informáticos']);
    });

    it('empty/blank query produces no terms', () => {
      expect(buildSearchTerms('')).toEqual([]);
      expect(buildSearchTerms('   ')).toEqual([]);
    });

    it('falls back to whole phrase when every word is under 3 chars', () => {
      expect(buildSearchTerms('IA y')).toEqual(['ia y']);
    });

    it('escapes quotes inside terms (no SQL injection)', () => {
      const terms = buildSearchTerms("obras'; DROP TABLE x; --");
      expect(terms.length).toBeGreaterThan(0);
      for (const t of terms) {
        expect(t).not.toMatch(/[^']'[^']/); // no lone single quotes — only escaped ''
      }
      expect(terms.join('|')).toContain("''");
    });
  });

  describe('SQL execution against in-memory DuckDB', () => {
    let db: duckdb.Database;

    beforeAll(async () => {
      db = new duckdb.Database(':memory:');
      // Fixture sobre la tabla materializada `contratos_busqueda`.
      await run(db, `
        CREATE TABLE contratos_busqueda (
          id VARCHAR, fuente VARCHAR, expediente VARCHAR, organismo VARCHAR,
          objeto VARCHAR, cpv VARCHAR, cpvs VARCHAR,
          importe_licitacion DOUBLE, importe_adjudicacion DOUBLE,
          fecha_publicacion DATE, fecha_fin DATE, url VARCHAR,
          estado VARCHAR, adjudicatario VARCHAR, nif_adjudicatario VARCHAR
        )
      `);
      await run(db, `
        INSERT INTO contratos_busqueda VALUES
          ('r1','PLACE','EXP-A','Ayuntamiento Demo','Suministro de equipos informáticos para oficinas',null,null,
           100000, 90000, DATE '2024-05-01', NULL, 'http://a', 'adjudicada', 'Prov 1', 'A1'),
          ('r2','PLACE','EXP-B','Diputación Demo','Reparación de equipos diversos',null,null,
           50000, 40000, DATE '2024-02-01', NULL, 'http://b', 'publicada', 'Prov 2', 'B2'),
          ('r3','PLACE','EXP-C','Congreso Demo','Obras de reparación de fachada',null,null,
           80000, 70000, DATE '2024-03-01', NULL, 'http://c', 'adjudicada', 'Prov 3', 'C3')
      `);
    });

    afterAll(() => {
      db.close();
    });

    it('multi-word query: OR across terms, ranked by matched-term count', async () => {
      const q = buildUnionQuery('equipos informáticos', {});
      const rows = await exec(db, q.dataSql).then(bigIntSafe);
      // r1 matches both terms (_score 2) → first; r2 matches 'equipos' only; r3 excluded
      expect(rows.map((r: any) => r.id)).toEqual(['r1', 'r2']);
    });

    it('natural-language query returns results (the 12-zero-queries bug)', async () => {
      const q = buildUnionQuery('reparación de fachada en edificio público', {});
      const rows = await exec(db, q.dataSql).then(bigIntSafe);
      // r3 matches 'reparación' + 'fachada'; r2 matches 'reparación'; stopwords dropped
      expect(rows.map((r: any) => r.id)).toEqual(['r3', 'r2']);
    });

    it('quoted phrase keeps exact-phrase behavior', async () => {
      const q = buildUnionQuery('"equipos informáticos"', {});
      const rows = await exec(db, q.dataSql).then(bigIntSafe);
      expect(rows.map((r: any) => r.id)).toEqual(['r1']);
    });

    it('words under 3 chars are dropped without killing the query', async () => {
      const q = buildUnionQuery('equipos de', {});
      const rows = await exec(db, q.dataSql).then(bigIntSafe);
      expect(rows.map((r: any) => r.id)).toEqual(['r1', 'r2']); // tie on _score → fecha DESC
    });

    it('explicit sort still wins over relevance ordering', () => {
      const q = buildUnionQuery('equipos', { sort: 'titulo', dir: 'asc' });
      expect(q.dataSql).toContain('ORDER BY titulo ASC');
      expect(q.dataSql).not.toContain('_score DESC');
    });

    it('_score drives ordering (proyección interna; exponerla o no es decisión del consumidor)', async () => {
      const q = buildUnionQuery('equipos informáticos', {});
      expect(q.dataSql).toContain('ORDER BY _score DESC');
      const rows = await exec(db, q.dataSql).then(bigIntSafe);
      expect(rows[0].id).toBe('r1'); // r1 casa los dos términos (_score 2)
      expect(rows[1].id).toBe('r2'); // r2 casa solo 'equipos' (_score 1)
      expect(rows[0]._score).toBe(2);
    });
  });
});