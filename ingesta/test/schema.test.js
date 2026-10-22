/**
 * schema.test.js — Caracterización de la validación de contratos (ingesta/lib/schema.js).
 *
 * Fija el contrato mínimo de entrada al merge: lo que entra y lo que se rechaza,
 * incluidos los casos reales de importes absurdos documentados en la cabecera
 * del módulo (taller Oviedo €251B, SAS €560B, UTE GOMSL €90B — valores
 * anonimizados aquí: solo la magnitud).
 *
 * Run: cd ingesta && npm test
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateContratos,
  normalizeEstado,
  extractText,
  MAX_IMPORTE_LICITACION,
  MAX_IMPORTE_ADJUDICACION,
  ADJUD_OVER_LICIT_FACTOR,
} = require('../lib/schema');

function contratoValido(overrides = {}) {
  return {
    id: 'TEST:0001',
    fuente: 'TEST',
    fecha_publicacion: '2026-09-15',
    titulo: 'Contrato de caracterización',
    estado: 'abierta',
    ...overrides,
  };
}

const UMBRAL = 5_000_000_000;

describe('umbrales documentados', () => {
  test('los constantes exportados coinciden con la cabecera del módulo', () => {
    assert.equal(MAX_IMPORTE_LICITACION, UMBRAL);
    assert.equal(MAX_IMPORTE_ADJUDICACION, UMBRAL);
    assert.equal(ADJUD_OVER_LICIT_FACTOR, 10);
  });
});

describe('validateContratos — contrato mínimo', () => {
  test('contrato completo válido → valid con fuente y estado normalizados', () => {
    const { valid, rejected } = validateContratos(
      [contratoValido({ estado: 'ADJUDICADA ' })],
      { fuente: 'TEST' }
    );
    assert.equal(rejected.length, 0);
    assert.equal(valid.length, 1);
    assert.equal(valid[0].fuente, 'TEST');
    assert.equal(valid[0].estado, 'adjudicada');
  });

  test('sin id → rechazado', () => {
    const { rejected } = validateContratos([contratoValido({ id: '' })], { fuente: 'TEST' });
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].errors.join(' '), /missing or empty id/);
  });

  test('sin fuente en contrato ni en opts → rechazado', () => {
    const { rejected } = validateContratos([contratoValido({ fuente: undefined })], {});
    assert.match(rejected[0].errors.join(' '), /missing fuente/);
  });

  test('la fuente de opts rellena el contrato que no la trae', () => {
    const { valid } = validateContratos([contratoValido({ fuente: undefined })], { fuente: 'EUSKADI' });
    assert.equal(valid[0].fuente, 'EUSKADI');
  });

  test('sin titulo ni objeto → rechazado', () => {
    const { rejected } = validateContratos([contratoValido({ titulo: '', objeto: '' })], { fuente: 'TEST' });
    assert.match(rejected[0].errors.join(' '), /missing titulo\/objeto/);
  });

  test('objeto suple la ausencia de titulo', () => {
    const { valid, rejected } = validateContratos(
      [contratoValido({ titulo: '', objeto: 'Suministro de caracterización' })],
      { fuente: 'TEST' }
    );
    assert.equal(rejected.length, 0);
    assert.equal(valid.length, 1);
  });
});

describe('validateContratos — fechas', () => {
  test('fecha_publicacion con formato no ISO → rechazado', () => {
    const { rejected } = validateContratos(
      [contratoValido({ fecha_publicacion: '15/09/2026' })],
      { fuente: 'TEST' }
    );
    assert.match(rejected[0].errors.join(' '), /invalid fecha_publicacion format/);
  });

  test('epoch/1970 (clase del bug detectado en /api/v1/sector) → rechazado por año absurdo', () => {
    const { rejected } = validateContratos(
      [contratoValido({ fecha_publicacion: '1970-01-01' })],
      { fuente: 'TEST' }
    );
    assert.match(rejected[0].errors.join(' '), /absurd fecha_publicacion year: 1970/);
  });

  test('año futuro absurdo (2101) → rechazado', () => {
    const { rejected } = validateContratos(
      [contratoValido({ fecha_publicacion: '2101-01-01' })],
      { fuente: 'TEST' }
    );
    assert.match(rejected[0].errors.join(' '), /absurd fecha_publicacion year: 2101/);
  });

  test('fecha_fin_presentacion absurda → rechazado', () => {
    const { rejected } = validateContratos(
      [contratoValido({ fecha_fin_presentacion: '1999-12-31' })],
      { fuente: 'TEST' }
    );
    assert.match(rejected[0].errors.join(' '), /absurd fecha_fin year: 1999/);
  });
});

describe('validateContratos — importes (sanity checks)', () => {
  test('importe negativo → rechazado', () => {
    const { rejected } = validateContratos(
      [contratoValido({ importe_licitacion: -5 })],
      { fuente: 'TEST' }
    );
    assert.match(rejected[0].errors.join(' '), /invalid importe_licitacion/);
  });

  test('importe como string → rechazado', () => {
    const { rejected } = validateContratos(
      [contratoValido({ importe_adjudicacion: '1000' })],
      { fuente: 'TEST' }
    );
    assert.match(rejected[0].errors.join(' '), /invalid importe_adjudicacion/);
  });

  test('importe > €5B (magnitud del caso real taller Oviedo) → rechazado como absurdo', () => {
    const { rejected } = validateContratos(
      [contratoValido({ importe_licitacion: 251_000_000_000 })],
      { fuente: 'TEST' }
    );
    assert.match(rejected[0].errors.join(' '), /absurd importe_licitacion/);
  });

  test('importe de adjudicación > €5B (magnitud del caso real SAS) → rechazado', () => {
    const { rejected } = validateContratos(
      [contratoValido({ importe_adjudicacion: 560_000_000_000 })],
      { fuente: 'TEST' }
    );
    assert.match(rejected[0].errors.join(' '), /absurd importe_adjudicacion/);
  });

  test('importe 0 es válido (licitación sin presupuesto publicado)', () => {
    const { valid, rejected } = validateContratos(
      [contratoValido({ importe_licitacion: 0 })],
      { fuente: 'TEST' }
    );
    assert.equal(rejected.length, 0);
    assert.equal(valid[0].importe_licitacion, 0);
  });

  test('adjudicación > 10× licitación NO se rechaza (modificaciones contractuales legítimas)', () => {
    // Caracterización + regresión: este caso lanzaba ReferenceError (opts is not
    // definida) antes del fix del 12-10 — un contrato así tumbaba el merge entero.
    const { valid, rejected } = validateContratos(
      [contratoValido({ importe_licitacion: 1000, importe_adjudicacion: 50_000 })],
      { fuente: 'TEST' }
    );
    assert.equal(rejected.length, 0, 'el módulo no rechaza — solo conviene revisarlo');
    assert.equal(valid.length, 1);
  });

  test('cpvs como string (no array) → rechazado', () => {
    const { rejected } = validateContratos(
      [contratoValido({ cpvs: '33140000' })],
      { fuente: 'TEST' }
    );
    assert.match(rejected[0].errors.join(' '), /cpvs is not array/);
  });
});

describe('normalizeEstado', () => {
  test('conocido → minúsculas y sin espacios', () => {
    assert.equal(normalizeEstado('Publicada '), 'publicada');
  });

  test('mappings por substring: adjudicado/formalizada/resuelto/anulada/desierta/retirada', () => {
    assert.equal(normalizeEstado('adjudicado provisionalmente'), 'adjudicada');
    assert.equal(normalizeEstado('contrato formalizado'), 'formalizada');
    assert.equal(normalizeEstado('expediente resuelto'), 'resuelta');
    assert.equal(normalizeEstado('licitación anulada'), 'anulada');
    assert.equal(normalizeEstado('procedimiento desierto'), 'desierta');
    assert.equal(normalizeEstado('anuncio retirado'), 'retirada');
  });

  test('pendiente/evaluación por substring → pendiente', () => {
    // 'pendiente de adjudicación' es un estado CONOCIDO del set → se devuelve tal cual
    assert.equal(normalizeEstado('pendiente de adjudicación'), 'pendiente de adjudicación');
    assert.equal(normalizeEstado('pendiente de resolver'), 'pendiente');
    assert.equal(normalizeEstado('fase de evaluación'), 'pendiente');
  });

  test('desconocido y vacío → desconocido', () => {
    assert.equal(normalizeEstado('nada que encaje'), 'desconocido');
    assert.equal(normalizeEstado(null), 'desconocido');
    assert.equal(normalizeEstado(''), 'desconocido');
  });
});

describe('extractText (texto multilingüe)', () => {
  test('string → idéntico', () => {
    assert.equal(extractText('texto plano'), 'texto plano');
  });

  test('array multilengua → prioridad spa sobre eng', () => {
    const val = [
      { '@language': 'eng', '#text': 'Cleaning service' },
      { '@language': 'spa', '#text': 'Servicio de limpieza' },
    ];
    assert.equal(extractText(val), 'Servicio de limpieza');
  });

  test('array sin ninguna lengua prioritaria → primer elemento como fallback', () => {
    // ni 'cat' ni 'deu' están en langPriority ['spa','eng'] → cae a val[0]
    const val = [
      { '@language': 'cat', '#text': 'Servei de neteja' },
      { '@language': 'deu', '#text': 'Reinigungsdienst' },
    ];
    assert.equal(extractText(val), 'Servei de neteja');
  });

  test('objeto con #text → su texto', () => {
    assert.equal(extractText({ '#text': 'texto xml2js' }), 'texto xml2js');
  });

  test('vacío → cadena vacía', () => {
    assert.equal(extractText(null), '');
    assert.equal(extractText(''), '');
  });
});
