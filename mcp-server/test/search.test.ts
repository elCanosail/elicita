import assert from 'node:assert/strict';
import test from 'node:test';
import { mapSearchParams, toStructuredSearchResponse } from '../src/tools/search.js';

test('maps MCP search filters and direction without sending sort', () => {
  assert.deepEqual(
    mapSearchParams({
      q: 'software',
      cpv: '72',
      importe_min: 10_000,
      importe_max: 50_000,
      fecha_desde: '2025',
      fecha_hasta: '2026',
      dir: 'asc',
      limit: 10,
      offset: 20,
    }),
    {
      q: 'software',
      cpv: '72',
      limit: 10,
      offset: 20,
      importeMin: 10_000,
      importeMax: 50_000,
      desde: '2025',
      hasta: '2026',
      dir: 'asc',
    }
  );
});

test('passes canonical sort fields through to the API', () => {
  assert.deepEqual(mapSearchParams({ sort: 'fecha', dir: 'asc' }), { sort: 'fecha', dir: 'asc' });
  assert.deepEqual(mapSearchParams({ sort: 'importe', dir: 'desc' }), { sort: 'importe', dir: 'desc' });
});

test('omits sort when absent or empty, preserving the backend default', () => {
  assert.equal(mapSearchParams({}).sort, undefined);
  assert.equal(mapSearchParams({ sort: '' }).sort, undefined);
});

test('rejects legacy colon syntax explicitly', () => {
  for (const sort of ['fecha:desc', 'importe:asc', ':asc']) {
    assert.throws(() => mapSearchParams({ sort }), /Sintaxis de ordenación legacy no soportada/);
  }
});

test('rejects unknown or non-canonical sort fields', () => {
  for (const sort of ['titulo2', 'importe_licitacion', 'fecha_publicacion', 'objeto', 'NOT A FIELD', '; DROP']) {
    assert.throws(() => mapSearchParams({ sort }), /Campo de ordenación no soportado/);
  }
});

test('accepts every canonical sort field', () => {
  for (const sort of ['titulo', 'organismo', 'adjudicatario', 'importe', 'fuente', 'fecha']) {
    assert.deepEqual(mapSearchParams({ sort }), { sort });
  }
});

test('normalizes the structured search response', () => {
  const response = toStructuredSearchResponse({
    results: [{ id: 'contract-1' }],
    pagination: { limit: 20, offset: 0, has_more: false },
    meta: { total: 1, took_ms: 4 },
    ignored: 'not part of the MCP v1 response contract',
  });

  assert.deepEqual(response, {
    results: [{ id: 'contract-1' }],
    pagination: { limit: 20, offset: 0, has_more: false },
    meta: { total: 1, took_ms: 4 },
  });
});


test('does not turn malformed upstream responses into successful empty searches', () => {
  for (const value of [null, 'html', {}, { error: 'upstream failure' }]) {
    assert.throws(() => toStructuredSearchResponse(value), /inválida/);
  }
});
