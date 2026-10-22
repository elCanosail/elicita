/**
 * merge.test.js — Caracterización de las reglas de retención D013 (DECISIONS.md)
 * y del merge-by-ID de ingesta/lib/merge.js.
 *
 * Tests de caracterización: fijan el comportamiento ACTUAL, no el deseado.
 * Fechas relativas a Date.now() para que la suite no se pudra.
 *
 * Run: cd ingesta && npm test
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  mergeAndWrite,
  isActive,
  isTerminal,
  shouldRetain,
} = require('../lib/merge');

const DAY_MS = 86_400_000;

// Fecha ISO (YYYY-MM-DD) de hace n días, calculada en el momento del test
function diasAtras(n) {
  return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}
function diasEnElFuturo(n) {
  return new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
}

const NOW = new Date();

function contratoBase(overrides = {}) {
  return {
    id: 'TEST:0001',
    fuente: 'TEST',
    fecha_publicacion: diasAtras(30),
    titulo: 'Contrato de caracterización',
    estado: 'desconocido',
    ...overrides,
  };
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'merge-test-')), 'contratos.json');
}

function limpiar(file) {
  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch {}
}

/* ── isActive / isTerminal ─────────────────────────────────────────── */

describe('isActive (D013 regla 1)', () => {
  test('estado activo conocido → true', () => {
    assert.equal(isActive(contratoBase({ estado: 'abierta' })), true);
  });

  test("'en curso' (con espacio final en el set de Galicia) → true", () => {
    assert.equal(isActive(contratoBase({ estado: 'en curso' })), true);
    assert.equal(isActive(contratoBase({ estado: 'en curso ' })), true);
  });

  test('estado desconocido pero fecha_fin futura → true', () => {
    const c = contratoBase({ estado: 'convocatoria pendiente de publicación', fecha_fin: diasEnElFuturo(10) });
    assert.equal(isActive(c), true);
  });

  test('estado desconocido sin fecha_fin → false', () => {
    assert.equal(isActive(contratoBase({ estado: 'algún estado raro' })), false);
  });

  test("mayúsculas y espacios se normalizan ('Publicada ')", () => {
    assert.equal(isActive(contratoBase({ estado: 'Publicada ' })), true);
  });
});

describe('isTerminal (D013 regla 3)', () => {
  test("'adjudicada' → true", () => {
    assert.equal(isTerminal(contratoBase({ estado: 'adjudicada' })), true);
  });

  test("'formalizada' → true", () => {
    assert.equal(isTerminal(contratoBase({ estado: 'formalizada' })), true);
  });

  test("'abierta' → false", () => {
    assert.equal(isTerminal(contratoBase({ estado: 'abierta' })), false);
  });
});

/* ── shouldRetain ──────────────────────────────────────────────────── */

describe('shouldRetain (D013 reglas 1-4)', () => {
  test('ACTIVO se mantiene SIEMPRE aunque sea de 2020', () => {
    const c = contratoBase({ estado: 'abierta', fecha_publicacion: '2020-01-15' });
    assert.equal(shouldRetain(c, NOW), true);
  });

  test('adjudicada reciente (100 días ≤ 730) → se mantiene', () => {
    const c = contratoBase({ estado: 'adjudicada', fecha_publicacion: diasAtras(100) });
    assert.equal(shouldRetain(c, NOW), true);
  });

  test('adjudicada antigua (800 días > 730) → se purga', () => {
    const c = contratoBase({ estado: 'adjudicada', fecha_publicacion: diasAtras(800) });
    assert.equal(shouldRetain(c, NOW), false);
  });

  test('terminal sin fecha → se conserva por seguridad', () => {
    const c = contratoBase({ estado: 'adjudicada', fecha_publicacion: null });
    assert.equal(shouldRetain(c, NOW), true);
  });

  test('estado desconocido reciente (100 días ≤ 180) → se mantiene', () => {
    const c = contratoBase({ estado: 'estado raro', fecha_publicacion: diasAtras(100) });
    assert.equal(shouldRetain(c, NOW), true);
  });

  test('estado desconocido antiguo (200 días > 180) → se purga', () => {
    const c = contratoBase({ estado: 'estado raro', fecha_publicacion: diasAtras(200) });
    assert.equal(shouldRetain(c, NOW), false);
  });

  test('sin fecha ni estado reconocido → red de seguridad conserva', () => {
    const c = contratoBase({ estado: 'estado raro', fecha_publicacion: null });
    assert.equal(shouldRetain(c, NOW), true);
  });
});

/* ── mergeAndWrite ─────────────────────────────────────────────────── */

describe('mergeAndWrite (upsert por ID + stats)', () => {
  test('upsert: mismo id actualiza sin duplicar y preserva _first_seen', () => {
    const file = tmpFile();
    try {
      const existentes = {
        fuente: 'PLACSP',
        contratos: [{
          id: 'PLACSP:X1',
          fuente: 'PLACSP',
          fecha_publicacion: '2026-01-15',
          titulo: 'título antiguo',
          estado: 'publicada',
          _first_seen: '2026-01-15T00:00:00.000Z',
        }],
      };
      fs.writeFileSync(file, JSON.stringify(existentes), 'utf8');

      const nuevos = [{
        id: 'PLACSP:X1',
        fuente: 'PLACSP',
        fecha_publicacion: diasAtras(5), // atom:updated — más reciente
        titulo: 'título actualizado',
        estado: 'publicada',
      }];

      const stats = mergeAndWrite(file, nuevos, { fuente: 'PLACSP', log: () => {} });
      assert.equal(stats.total, 1, 'sin duplicados');
      assert.equal(stats.updated, 1);
      assert.equal(stats.added, 0);

      const guardado = JSON.parse(fs.readFileSync(file, 'utf8'));
      const c = guardado.contratos[0];
      assert.equal(c.titulo, 'título actualizado', 'los nuevos tienen prioridad');
      assert.equal(c._first_seen, '2026-01-15T00:00:00.000Z', '_first_seen del original preservado');
      assert.ok(c._merged_at, 'marca _merged_at del ciclo');
    } finally {
      limpiar(file);
    }
  });

  test('PLACSP: fecha_publicacion original se preserva y la actualización va a fecha_actualizacion', () => {
    const file = tmpFile();
    try {
      const existentes = {
        fuente: 'PLACSP',
        contratos: [{
          id: 'PLACSP:Y1',
          fuente: 'PLACSP',
          fecha_publicacion: '2026-01-15',
          estado: 'publicada',
          titulo: 'original',
          _first_seen: '2026-01-15T00:00:00.000Z',
        }],
      };
      fs.writeFileSync(file, JSON.stringify(existentes), 'utf8');

      const actualizada = diasAtras(5);
      const nuevos = [{
        id: 'PLACSP:Y1',
        fuente: 'PLACSP',
        fecha_publicacion: actualizada,
        estado: 'publicada',
        titulo: 'original',
      }];

      mergeAndWrite(file, nuevos, { fuente: 'PLACSP', log: () => {} });

      const c = JSON.parse(fs.readFileSync(file, 'utf8')).contratos[0];
      assert.equal(c.fecha_publicacion, '2026-01-15', 'fecha original del primer ingreso');
      assert.equal(c.fecha_actualizacion, actualizada, 'atom:updated en campo separado');
    } finally {
      limpiar(file);
    }
  });

  test('stats y purga: activo viejo sobrevive, desconocido >180d se purga, nuevo se añade', () => {
    const file = tmpFile();
    try {
      const existentes = {
        fuente: 'TEST',
        contratos: [
          contratoBase({ id: 'T:ACTIVO', estado: 'abierta', fecha_publicacion: '2020-01-01' }),
          contratoBase({ id: 'T:VIEJO', estado: 'estado raro', fecha_publicacion: diasAtras(200) }),
          contratoBase({ id: 'T:ADJ', estado: 'adjudicada', fecha_publicacion: diasAtras(100) }),
        ],
      };
      fs.writeFileSync(file, JSON.stringify(existentes), 'utf8');

      const nuevos = [contratoBase({ id: 'T:NUEVO', estado: 'abierta' })];
      const stats = mergeAndWrite(file, nuevos, { fuente: 'TEST', log: () => {} });

      assert.equal(stats.added, 1);
      assert.equal(stats.updated, 0);
      assert.equal(stats.purged, 1, 'solo T:VIEJO purgado');
      assert.equal(stats.total, 3, 'activo 2020 + adjudicada 100d + nuevo');

      const ids = JSON.parse(fs.readFileSync(file, 'utf8')).contratos.map((c) => c.id).sort();
      assert.deepEqual(ids, ['T:ACTIVO', 'T:ADJ', 'T:NUEVO']);
    } finally {
      limpiar(file);
    }
  });

  test('JSON existente corrupto → parte de vacío sin explotar', () => {
    const file = tmpFile();
    try {
      fs.writeFileSync(file, '{ esto no es JSON', 'utf8');
      const stats = mergeAndWrite(file, [contratoBase({ id: 'T:OK', estado: 'abierta' })], { fuente: 'TEST', log: () => {} });
      assert.equal(stats.total, 1);
      assert.equal(stats.added, 1);
    } finally {
      limpiar(file);
    }
  });

  test('contrato nuevo inválido (importe €251B, clase del caso real taller Oviedo) → rechazado por schema, no entra', () => {
    const file = tmpFile();
    try {
      const absurdos = [contratoBase({ id: 'T:ABSURDO', estado: 'adjudicada', importe_licitacion: 251e9 })];
      const stats = mergeAndWrite(file, absurdos, { fuente: 'TEST', log: () => {} });
      assert.equal(stats.total, 0, 'ningún contrato en el fichero');
      assert.equal(stats.added, 0);
    } finally {
      limpiar(file);
    }
  });

  test('orden del fichero: activos primero, luego por fecha desc', () => {
    const file = tmpFile();
    try {
      const nuevos = [
        contratoBase({ id: 'T:ADJ-ANTIGUA', estado: 'adjudicada', fecha_publicacion: diasAtras(400) }),
        contratoBase({ id: 'T:ABIERTA-VIEJA', estado: 'abierta', fecha_publicacion: diasAtras(90) }),
        contratoBase({ id: 'T:ABIERTA-NUEVA', estado: 'abierta', fecha_publicacion: diasAtras(10) }),
      ];
      mergeAndWrite(file, nuevos, { fuente: 'TEST', log: () => {} });

      const ids = JSON.parse(fs.readFileSync(file, 'utf8')).contratos.map((c) => c.id);
      assert.deepEqual(ids, ['T:ABIERTA-NUEVA', 'T:ABIERTA-VIEJA', 'T:ADJ-ANTIGUA']);
    } finally {
      limpiar(file);
    }
  });
});
