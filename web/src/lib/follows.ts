/**
 * Lógica pura de follows (sin dependencias de Clerk ni Astro).
 *
 * Shape del metadata de Clerk consumido por:
 *   - web/src/pages/api/follows.ts (lectura/escritura)
 *   - ingesta/reporte-semanal.js (informe semanal «para tu perfil»)
 *
 *   user.publicMetadata.follows = {
 *     organismos:  [{ id, nombre, createdAt }],
 *     competidores:[{ id, nombre, createdAt }],
 *     proveedores: [{ id: NIF, nombre, createdAt }],   // ← F1.2 seguir perfil
 *   }
 */

export type FollowType = 'organismo' | 'competidor' | 'proveedor';

export interface FollowEntry {
  id: string;
  nombre: string;
  createdAt?: string;
}

export interface Follows {
  organismos: FollowEntry[];
  competidores: FollowEntry[];
  proveedores: FollowEntry[];
}

/** Límite combinado (organismos + competidores) para usuarios Free. */
export const MAX_FOLLOWS_FREE = 3;

/** Límite de perfiles de proveedor (por NIF) para usuarios Free. F1.2. */
export const MAX_PROVEEDORES_FREE = 1;

const FOLLOW_KEYS: Record<FollowType, keyof Omit<Follows, never>> = {
  organismo: 'organismos',
  competidor: 'competidores',
  proveedor: 'proveedores',
};

export function followKey(type: FollowType): keyof Follows {
  return FOLLOW_KEYS[type];
}

/** Normaliza el shape leído de Clerk publicMetadata (defensivo, nunca lanza). */
export function getFollows(metadata: Record<string, any>): Follows {
  const follows = metadata?.follows || {};
  const list = (v: unknown): FollowEntry[] =>
    Array.isArray(v)
      ? v.filter((f) => f && typeof f === 'object' && f.id != null)
      : [];
  return {
    organismos: list(follows.organismos),
    competidores: list(follows.competidores),
    proveedores: list(follows.proveedores),
  };
}

/** Recuento combinado de organismo+competidor (semántica previa a F1.2). */
export function countFollows(follows: Follows): number {
  return follows.organismos.length + follows.competidores.length;
}

export interface FollowCheckOk {
  ok: true;
}
export interface FollowCheckDenied {
  ok: false;
  status: 403;
  payload: {
    error: string;
    upgrade?: string;
    manageUrl?: string;
  };
}

/**
 * ¿Puede el usuario añadir un follow de `type`?
 * - Pro (alerts): sin límite.
 * - Free organismo/competidor: MAX_FOLLOWS_FREE combinado.
 * - Free proveedor: MAX_PROVEEDORES_FREE.
 * El caso «ya lo sigue» se gestiona antes (idempotente) en el endpoint.
 */
export function checkFollowAllowed(
  type: FollowType,
  follows: Follows,
  isPro: boolean,
): FollowCheckOk | FollowCheckDenied {
  if (isPro) return { ok: true };

  if (type === 'proveedor') {
    if (follows.proveedores.length >= MAX_PROVEEDORES_FREE) {
      return {
        ok: false,
        status: 403,
        payload: {
          error: 'Ya sigues otro perfil — gestiona tus seguimientos',
          manageUrl: '/cuenta/alertas',
          upgrade: '/precios',
        },
      };
    }
    return { ok: true };
  }

  if (countFollows(follows) >= MAX_FOLLOWS_FREE) {
    return {
      ok: false,
      status: 403,
      payload: {
        error: 'Límite de seguimientos alcanzado',
        upgrade: '/precios',
      },
    };
  }
  return { ok: true };
}
