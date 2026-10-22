'use strict';

/**
 * Tests de ingesta/lib/borme-actos.js — espejo de web/src/lib/__tests__/borme.test.ts
 * (fase 1-2 del plan BORME 2026-10-14). Mismas reglas en ambos lados: cualquier
 * cambio de normalización/match debe replicarse y reflejarse aquí y allá.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeBormeName,
  bormeMatchKey,
  toIsoFecha,
  bormePdfUrl,
  queryBormeActosSeguidos,
  groupActosByDate,
} = require('../lib/borme-actos');

test('normalizeBormeName: recorta sufijos societarios finales', () => {
  assert.strictEqual(normalizeBormeName('INDRA SISTEMAS SA'), 'INDRA SISTEMAS');
  assert.strictEqual(normalizeBormeName('JAGUSETAS SOCIEDAD LIMITADA'), 'JAGUSETAS');
  assert.strictEqual(normalizeBormeName('MILQUERH SL'), 'MILQUERH');
});

test('normalizeBormeName: conserva acentos, comas y puntos como upstream', () => {
  assert.strictEqual(
    normalizeBormeName('IBERICA DE DISTRIBUCION Y OPERADORES EXTREMEÑOS SL'),
    'IBERICA DE DISTRIBUCION Y OPERADORES EXTREMEÑOS',
  );
  assert.strictEqual(
    normalizeBormeName('ALONSO CONSTRUCCION, MANTENIMIENTO Y MEDIO AMBIENTE SL'),
    'ALONSO CONSTRUCCION, MANTENIMIENTO Y MEDIO AMBIENTE',
  );
});

test('normalizeBormeName: no recorta con anotación de unipersonalidad (regla upstream)', () => {
  assert.strictEqual(
    normalizeBormeName('SERVICIOS TRIBUTARIOS ADMINISTRACION LOCAL SL. Sociedad unipersonal'),
    'SERVICIOS TRIBUTARIOS ADMINISTRACION LOCAL SL. SOCIEDAD UNIPERSONAL',
  );
});

test('bormeMatchKey: igualdad exacta sin puntuación, distingue prefijos', () => {
  assert.strictEqual(bormeMatchKey('FAES FARMA, S.A.'), bormeMatchKey('FAES FARMA SA'));
  assert.strictEqual(bormeMatchKey('OCTAPHARMA,S.A.'), bormeMatchKey('OCTAPHARMA'));
  assert.notStrictEqual(bormeMatchKey('INDRA SISTEMAS'), bormeMatchKey('INDRA'));
});

test('toIsoFecha: Date, ISO y formato upstream DD.MM.YY[.]', () => {
  assert.strictEqual(toIsoFecha(new Date(Date.UTC(2026, 0, 2))), '2026-01-02');
  assert.strictEqual(toIsoFecha('2026-02-18 00:00:00'), '2026-02-18');
  assert.strictEqual(toIsoFecha('22.01.26.'), '2026-01-22');
  assert.strictEqual(toIsoFecha('27.10.99'), '1999-10-27');
  assert.strictEqual(toIsoFecha(null), null);
});

test('bormePdfUrl: URL oficial de boe.es desde filename + fecha', () => {
  assert.strictEqual(
    bormePdfUrl('BORME-A-2009-21-28.pdf', '2009-02-02'),
    'https://www.boe.es/borme/dias/2009/02/02/pdfs/BORME-A-2009-21-28.pdf',
  );
  assert.strictEqual(bormePdfUrl(null, '2026-02-18'), null);
  assert.strictEqual(bormePdfUrl('otro.pdf', '2026-02-18'), null);
});

test('groupActosByDate: agrupa fecha desc, dedupe de cabeceras, PDF de la fecha', () => {
  const rows = [
    { fecha_borme: '2026-10-05', empresa: 'A SL', actos: 'Nombramientos|Modificaciones estatutarias', pdf_filename: 'BORME-A-2026-190-28.pdf' },
    { fecha_borme: '2026-10-05', empresa: 'A SL', actos: 'Nombramientos', pdf_filename: 'BORME-A-2026-190-28.pdf' },
    { fecha_borme: '2015-05-12', empresa: 'A SL', actos: 'Constitución|Nombramientos', pdf_filename: 'BORME-A-2015-88-28.pdf' },
  ];
  const grupos = groupActosByDate(rows);
  assert.strictEqual(grupos.length, 2);
  assert.strictEqual(grupos[0].fecha, '2026-10-05');
  assert.deepStrictEqual(grupos[0].actos, ['Nombramientos', 'Modificaciones estatutarias']);
  assert.strictEqual(
    grupos[0].pdfUrl,
    'https://www.boe.es/borme/dias/2026/10/05/pdfs/BORME-A-2026-190-28.pdf',
  );
  assert.strictEqual(grupos[1].fecha, '2015-05-12');
});

test('queryBormeActosSeguidos: resolución nif_canonical → contratos → match por clave', async () => {
  const queries = [];
  const fakeQuery = async (sql, params) => {
    queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('nif_canonical')) {
      return [{ nif: 'A48004360', nombre: 'FAES FARMA, S.A.' }];
    }
    if (sql.includes('borme_empresas')) {
      assert.strictEqual(params[0], '2026-10-05');
      assert.strictEqual(params[1], '2026-10-11');
      assert.strictEqual(params[2], 'FAESFARMA');
      return [
        { fecha_borme: '2026-10-06', empresa: 'FAES FARMA SA', empresa_norm: 'FAES FARMA', actos: 'Nombramientos', pdf_filename: 'BORME-A-2026-191-48.pdf' },
      ];
    }
    return [];
  };

  const res = await queryBormeActosSeguidos(fakeQuery, [{ id: 'a48004360', nombre: 'Faes' }], '2026-10-05', '2026-10-11');
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].nif, 'A48004360');
  assert.strictEqual(res[0].nombre, 'FAES FARMA, S.A.');
  assert.strictEqual(res[0].actos.length, 1);
  // la query de actos usa la clave sin puntuación (igualdad, no LIKE)
  const q = queries.find((x) => x.sql.includes('borme_empresas'));
  assert.ok(q.sql.includes('regexp_replace(empresa_norm'));
  assert.ok(!q.sql.includes('LIKE'));
});

test('queryBormeActosSeguidos: fallback a contratos_vivos cuando no hay nif_canonical', async () => {
  const fakeQuery = async (sql, params) => {
    if (sql.includes('nif_canonical')) return []; // tabla vacía / inexistente
    if (sql.includes('contratos_vivos')) {
      assert.deepStrictEqual(params, ['B12345678']);
      return [{ nif: 'B12345678', nombre: 'EMPRESA FALSA SLU' }];
    }
    if (sql.includes('borme_empresas')) {
      assert.strictEqual(params[2], 'EMPRESAFALSA');
      return [{ fecha_borme: '2026-10-06', empresa: 'EMPRESA FALSA SL', empresa_norm: 'EMPRESA FALSA', actos: 'Ceses/Dimisiones', pdf_filename: 'BORME-A-2026-191-28.pdf' }];
    }
    return [];
  };
  const res = await queryBormeActosSeguidos(fakeQuery, [{ id: 'B12345678', nombre: 'X' }], '2026-10-05', '2026-10-11');
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].nombre, 'EMPRESA FALSA SLU');
});

test('queryBormeActosSeguidos: NIF sin match o sin actos → fuera del resultado', async () => {
  const fakeQuery = async (sql) => {
    if (sql.includes('nif_canonical')) return [{ nif: 'Z00000000', nombre: 'SIN BORME SL' }];
    if (sql.includes('contratos_vivos')) return [];
    return []; // borme_empresas sin actos en ventana
  };
  const res = await queryBormeActosSeguidos(fakeQuery, [{ id: 'Z00000000', nombre: 'X' }], '2026-10-05', '2026-10-11');
  assert.strictEqual(res.length, 0);
});

test('queryBormeActosSeguidos: sin proveedores → [] sin tocar la BD', async () => {
  let llamadas = 0;
  const res = await queryBormeActosSeguidos(async () => { llamadas++; return []; }, [], 'a', 'b');
  assert.strictEqual(res.length, 0);
  assert.strictEqual(llamadas, 0);
});
