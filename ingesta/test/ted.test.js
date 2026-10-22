/**
 * ted.test.js — Caracterización del conector TED (ingesta/connectors/ted.js):
 * normalizeEntry (forma del contrato TED) y mapEstadoTED (notice-type → estado).
 *
 * El fixture ingesta/test/fixtures/ted-entry-spa.json es una entrada TED
 * ANONIMIZADA (organismo ficticio, publicación de prueba) con la forma que
 * entrega la API de búsqueda a normalizeEntry tras el JSON.parse.
 *
 * Requiere que normalizeEntry y mapEstadoTED estén exportados además de run
 * (extracción mínima de helpers puros para testear — sin cambio de comportamiento).
 *
 * Run: cd ingesta && npm test
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeEntry, mapEstadoTED } = require('../connectors/ted');
const fixture = require('./fixtures/ted-entry-spa.json');

describe('mapEstadoTED (notice-type → estado)', () => {
  test('cn-* (Contract Notice) → abierta', () => {
    assert.equal(mapEstadoTED('cn-social'), 'abierta');
    assert.equal(mapEstadoTED('CN-STANDARD'), 'abierta');
  });

  test('can-* (Contract Award Notice) → adjudicada', () => {
    assert.equal(mapEstadoTED('can-standard'), 'adjudicada');
  });

  test('pin-* (Prior Information Notice) → anuncio_previo', () => {
    assert.equal(mapEstadoTED('pin-only'), 'anuncio_previo');
  });

  test('veat (Voluntary Ex Ante Transparency) → adjudicada', () => {
    assert.equal(mapEstadoTED('veat-transparency'), 'adjudicada');
  });

  test('null y tipos desconocidos → abierta (default conservador)', () => {
    assert.equal(mapEstadoTED(null), 'abierta');
    assert.equal(mapEstadoTED(''), 'abierta');
    assert.equal(mapEstadoTED('tipo-inexistente'), 'abierta');
  });
});

describe('normalizeEntry (entrada real del fixture anónimo)', () => {
  test('entrada completa del fixture → contrato con id TED, cpvs deduplicados y estado por notice-type', () => {
    const c = normalizeEntry(fixture);
    assert.ok(c, 'no debe devolver null');
    assert.equal(c.id, 'TED:001234-2026');
    assert.equal(c.fuente, 'TED');
    assert.equal(c.expediente, '001234-2026');
    // extractText prioriza spa aunque eng venga primero en el array
    assert.equal(c.titulo, 'Servicio de limpieza de instalaciones municipales');
    assert.deepEqual(c.cpvs, ['45210000', '45211100'], 'duplicados fuera, orden de aparición');
    assert.equal(c.importe_licitacion, 150000);
    assert.equal(c.fecha_publicacion, '2026-10-01');
    assert.equal(c.fecha_fin_presentacion, '2026-11-01T23:59:00Z');
    assert.equal(c.estado, 'abierta', 'cn-social → abierta');
    assert.equal(c.url_fuente, 'https://ted.europa.eu/es/notice/-/detail/001234-2026');
  });
});

describe('normalizeEntry (bordes de importes)', () => {
  test('estimated-value-lot como string único → parseFloat directo', () => {
    const c = normalizeEntry({ ...fixture, 'estimated-value-lot': '25000.5', 'notice-type': 'can-standard' });
    assert.equal(c.importe_licitacion, 25000.5);
    assert.equal(c.estado, 'adjudicada');
  });

  test('estimated-value-lot array → toma el primero', () => {
    const c = normalizeEntry({ ...fixture, 'estimated-value-lot': ['1000', '2000'] });
    assert.equal(c.importe_licitacion, 1000);
  });

  test('estimated-value-lot ausente o vacío → 0 (nunca NaN al JSON)', () => {
    const c1 = normalizeEntry({ ...fixture, 'estimated-value-lot': [] });
    assert.equal(c1.importe_licitacion, 0);
    const sinImporte = { ...fixture };
    delete sinImporte['estimated-value-lot'];
    const c2 = normalizeEntry(sinImporte);
    assert.equal(c2.importe_licitacion, 0);
    assert.ok(Number.isFinite(c2.importe_licitacion));
  });

  test('importe no numérico → 0', () => {
    const c = normalizeEntry({ ...fixture, 'estimated-value-lot': 'N/A' });
    assert.equal(c.importe_licitacion, 0);
  });
});

describe('normalizeEntry (bordes de identidad y enlaces)', () => {
  test('sin publication-number ni notice-identifier ni links → id TED: y URL por defecto', () => {
    const c = normalizeEntry({ ...fixture, 'publication-number': null, 'notice-identifier': null, links: null });
    assert.equal(c.id, 'TED:');
    assert.equal(c.url_fuente, 'https://ted.europa.eu/es/notice/-/detail/');
  });

  test('con links presentes, la URL manda sobre la construida con el pubNum', () => {
    const c = normalizeEntry({ ...fixture, 'publication-number': null, 'notice-identifier': null });
    assert.equal(c.id, 'TED:');
    assert.equal(c.url_fuente, 'https://ted.europa.eu/es/notice/-/detail/001234-2026');
  });

  test('notice-identifier suple la ausencia de publication-number', () => {
    const c = normalizeEntry({ ...fixture, 'publication-number': null, 'notice-identifier': '999999-2026' });
    assert.equal(c.id, 'TED:999999-2026');
  });

  test('links sin SPA → usa ENG', () => {
    const c = normalizeEntry({ ...fixture, links: { html: { ENG: 'https://ted.europa.eu/en/-/detail/001234-2026' } } });
    assert.equal(c.url_fuente, 'https://ted.europa.eu/en/-/detail/001234-2026');
  });

  test('organismo ausente → placeholder', () => {
    const c = normalizeEntry({ ...fixture, 'organisation-name-buyer': null });
    assert.equal(c.organismo, 'Organismo no especificado');
  });

  test('cpv único como string → array de un elemento', () => {
    const c = normalizeEntry({ ...fixture, 'classification-cpv': '33140000' });
    assert.deepEqual(c.cpvs, ['33140000']);
  });

  test('sin publication-date → timestamp de hoy como red de seguridad', () => {
    const c = normalizeEntry({ ...fixture, 'publication-date': null });
    const hoy = new Date().toISOString().slice(0, 10);
    assert.ok(c.fecha_publicacion.startsWith(hoy),
      `esperado ISO de hoy (${hoy}…), actual: ${c.fecha_publicacion}`);
  });
});
