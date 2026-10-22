/**
 * Tests de lib/follows.ts — F1.2 CTA «seguir proveedor» en /perfil/[nif].
 *
 * Cobertura:
 *  - Shape del metadata de Clerk que consume ingesta/reporte-semanal.js
 *    (follows.organismos / follows.competidores / follows.proveedores).
 *  - Límites por plan: Free 1 proveedor seguido; Pro sin límite;
 *    organismo/competidor Free con el límite combinado previo (3).
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_FOLLOWS_FREE,
  MAX_PROVEEDORES_FREE,
  checkFollowAllowed,
  followKey,
  getFollows,
  type Follows,
} from '../follows';

const entry = (id: string, nombre = `Proveedor ${id}`) => ({ id, nombre, createdAt: '2026-10-13T00:00:00Z' });

describe('getFollows — shape del metadata', () => {
  it('devuelve las tres listas vacías con metadata ausente', () => {
    expect(getFollows({})).toEqual({
      organismos: [],
      competidores: [],
      proveedores: [],
    });
    expect(getFollows({ follows: undefined })).toEqual({
      organismos: [],
      competidores: [],
      proveedores: [],
    });
  });

  it('respeta el shape existente (organismos/competidores) y añade proveedores', () => {
    const metadata = {
      follows: {
        organismos: [entry('Ayuntamiento de Vitoria-Gasteiz')],
        competidores: [entry('B12345678')],
      },
    };
    const follows = getFollows(metadata);
    expect(follows.organismos).toHaveLength(1);
    expect(follows.competidores).toHaveLength(1);
    expect(follows.proveedores).toEqual([]);
  });

  it('normaliza follows.proveedores por NIF (forma consumida por el reporte semanal)', () => {
    const metadata = {
      follows: {
        proveedores: [{ id: 'B01666666', nombre: 'Ficticia S.L.', createdAt: '2026-10-13T09:00:00Z' }],
      },
    };
    const follows = getFollows(metadata);
    expect(follows.proveedores).toEqual([
      { id: 'B01666666', nombre: 'Ficticia S.L.', createdAt: '2026-10-13T09:00:00Z' },
    ]);
  });

  it('es defensivo con valores no-array y entradas sin id', () => {
    const follows = getFollows({
      follows: {
        organismos: 'no-soy-array',
        proveedores: [null, { nombre: 'sin id' }, entry('A12345678')],
      },
    });
    expect(follows.organismos).toEqual([]);
    expect(follows.proveedores).toEqual([entry('A12345678')]);
  });
});

describe('followKey', () => {
  it('mapea cada tipo a su lista del metadata', () => {
    expect(followKey('organismo')).toBe('organismos');
    expect(followKey('competidor')).toBe('competidores');
    expect(followKey('proveedor')).toBe('proveedores');
  });
});

describe('checkFollowAllowed — límites por plan', () => {
  const followsWith = (counts: { organismos?: number; competidores?: number; proveedores?: number }): Follows => ({
    organismos: Array.from({ length: counts.organismos || 0 }, (_, i) => entry(`ORG${i}`)),
    competidores: Array.from({ length: counts.competidores || 0 }, (_, i) => entry(`CMP${i}`)),
    proveedores: Array.from({ length: counts.proveedores || 0 }, (_, i) => entry(`B0000000${i}`)),
  });

  it('constantes: Free 3 seguimientos combinados y 1 proveedor', () => {
    expect(MAX_FOLLOWS_FREE).toBe(3);
    expect(MAX_PROVEEDORES_FREE).toBe(1);
  });

  it('Pro no tiene límite en ningún tipo', () => {
    const full = followsWith({ organismos: 3, competidores: 3, proveedores: 1 });
    expect(checkFollowAllowed('proveedor', full, true).ok).toBe(true);
    expect(checkFollowAllowed('organismo', full, true).ok).toBe(true);
    expect(checkFollowAllowed('competidor', full, true).ok).toBe(true);
  });

  it('Free: primer proveedor permitido', () => {
    const check = checkFollowAllowed('proveedor', followsWith({}), false);
    expect(check).toEqual({ ok: true });
  });

  it('Free: segundo proveedor denegado con mensaje y enlace a /cuenta/alertas', () => {
    const check = checkFollowAllowed('proveedor', followsWith({ proveedores: 1 }), false);
    expect(check).toEqual({
      ok: false,
      status: 403,
      payload: {
        error: 'Ya sigues otro perfil — gestiona tus seguimientos',
        manageUrl: '/cuenta/alertas',
        upgrade: '/precios',
      },
    });
  });

  it('Free: el límite de proveedor es independiente del combinado de organismos/competidores', () => {
    const check = checkFollowAllowed('proveedor', followsWith({ organismos: 3 }), false);
    expect(check).toEqual({ ok: true });
  });

  it('Free: organismo/competidor conservan el límite combinado previo (3) con upgrade a /precios', () => {
    expect(checkFollowAllowed('organismo', followsWith({ organismos: 2 }), false)).toEqual({ ok: true });
    expect(checkFollowAllowed('competidor', followsWith({ organismos: 3 }), false)).toEqual({
      ok: false,
      status: 403,
      payload: { error: 'Límite de seguimientos alcanzado', upgrade: '/precios' },
    });
  });
});
