/**
 * Tests de la lógica F1.2 en ingesta/reporte-semanal.js (CJS):
 *  - groupProveedoresRows: agrupación de adjudicaciones de la semana por
 *    proveedor seguido (match por NIF normalizado, caps por proveedor).
 *  - normalizeNif.
 *
 * El módulo se importa como CommonJS (module.exports) y no abre la base de
 * datos en tiempo de importación (initDb solo se llama desde el runner).
 */

import { describe, expect, it } from 'vitest';
import reporte from '../../../../ingesta/reporte-semanal.js';

const { groupProveedoresRows, normalizeNif } = reporte as {
  groupProveedoresRows: (
    rows: any[],
    proveedores: { id: string; nombre?: string }[],
    maxProveedores?: number,
    maxContratos?: number,
  ) => any[];
  normalizeNif: (nif: string | null | undefined) => string;
};

const row = (id: string, nif: string, fecha: string) => ({
  id,
  nif_adjudicatario: nif,
  objeto: `Objeto ${id}`,
  importe_adjudicacion: 1000,
  fecha_publicacion: fecha,
});

describe('normalizeNif (reporte semanal)', () => {
  it('normaliza mayúsculas y separadores', () => {
    expect(normalizeNif(' b-01666666 ')).toBe('B01666666');
    expect(normalizeNif(null)).toBe('');
    expect(normalizeNif(undefined)).toBe('');
  });
});

describe('groupProveedoresRows (reporte semanal — F1.2)', () => {
  const proveedores = [
    { id: 'B01666666', nombre: 'Ficticia S.L.' },
    { id: 'A12345678', nombre: 'Otra S.A.' },
  ];

  it('agrupa filas por NIF y respeta el nombre del follow', () => {
    const rows = [
      row('c1', 'B01666666', '2026-10-06'),
      row('c2', 'b01666666', '2026-10-08'), // case-insensitive
      row('c3', 'A12345678', '2026-10-07'),
      row('c4', 'Z99999999', '2026-10-09'), // no seguido
    ];
    const grouped = groupProveedoresRows(rows, proveedores, 5, 3);
    expect(grouped).toHaveLength(2);

    const ficticia = grouped.find((g) => g.id === 'B01666666');
    expect(ficticia.nombre).toBe('Ficticia S.L.');
    expect(ficticia.n).toBe(2);
    expect(ficticia.contratos.map((c: any) => c.id)).toEqual(['c1', 'c2']);

    const otra = grouped.find((g) => g.id === 'A12345678');
    expect(otra.n).toBe(1);
  });

  it('cuenta el total (n) aunque capce contratos listados a maxContratos', () => {
    const rows = [
      row('c1', 'B01666666', '2026-10-06'),
      row('c2', 'B01666666', '2026-10-07'),
      row('c3', 'B01666666', '2026-10-08'),
      row('c4', 'B01666666', '2026-10-09'),
    ];
    const grouped = groupProveedoresRows(rows, proveedores, 5, 3);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].n).toBe(4);
    expect(grouped[0].contratos).toHaveLength(3);
  });

  it('excluye proveedores sin actividad y limita a maxProveedores', () => {
    const rows = [row('c1', 'B01666666', '2026-10-06')];
    const grouped = groupProveedoresRows(rows, proveedores, 5, 3);
    expect(grouped.map((g) => g.id)).toEqual(['B01666666']);

    const many = Array.from({ length: 8 }, (_, i) => ({ id: `N${i}`, nombre: `P${i}` }));
    const rowsMany = many.map((p, i) => row(`r${i}`, p.id, '2026-10-06'));
    expect(groupProveedoresRows(rowsMany, many, 5, 3)).toHaveLength(5);
  });

  it('devuelve vacío sin filas o sin proveedores', () => {
    expect(groupProveedoresRows([], proveedores)).toEqual([]);
    expect(groupProveedoresRows([row('c1', 'B01666666', '2026-10-06')], [])).toEqual([]);
  });
});
