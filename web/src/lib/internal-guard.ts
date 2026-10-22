/**
 * Guard común para endpoints internos y de test.
 *
 * El secreto se lee del entorno en TIEMPO DE EJECUCIÓN (`process.env`, no
 * `import.meta.env`): así no se inlinea en el build y un secreto definido en el
 * arranque de PM2 es visible sin recompilar. Se acepta `ADMIN_API_KEY` y, como
 * respaldo, el `ADMIN_SECRET` que ya usan los endpoints `admin/*`.
 *
 * Sin secreto definido el guard es FAIL-CLOSED: toda petición responde 403.
 * Cabecera aceptada: `Authorization: Bearer <secreto>` o `X-Admin-Key: <secreto>`.
 */

import { timingSafeEqual } from 'node:crypto';

/** Secreto admin efectivo (vacío si no hay ninguno definido). */
export function getAdminKey(): string {
  return (process.env.ADMIN_API_KEY || process.env.ADMIN_SECRET || '').trim();
}

/** true solo si NODE_ENV === 'development' (en producción queda sin definir → false). */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

/** Secreto presentado por la petición (Bearer o X-Admin-Key), o '' si no hay ninguno. */
export function extractProvidedKey(request: Request): string {
  const auth = request.headers.get('authorization') || '';
  const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
  const headerKey = (request.headers.get('x-admin-key') || '').trim();
  return bearer || headerKey;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function isAuthorizedAdmin(request: Request): boolean {
  const expected = getAdminKey();
  if (!expected) return false; // fail-closed
  const provided = extractProvidedKey(request);
  if (!provided) return false;
  return safeEqual(provided, expected);
}

/** Devuelve la respuesta 403 si la petición no está autorizada, o null si puede continuar. */
export function adminGuard(request: Request): Response | null {
  if (isAuthorizedAdmin(request)) return null;
  return new Response(JSON.stringify({ error: 'Forbidden', code: 'admin_required' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}
