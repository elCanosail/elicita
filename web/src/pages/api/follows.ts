/**
 * GET    /api/follows — Devuelve organismos, competidores y proveedores seguidos
 * POST   /api/follows — Añade un follow
 * DELETE /api/follows — Elimina un follow
 * Auth: Clerk session
 *
 * Shape en Clerk publicMetadata (consumido por ingesta/reporte-semanal.js):
 *   follows = { organismos: [], competidores: [], proveedores: [] }
 */
import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import { getUserPlan, canAccessFeature, type EffectivePlan } from '../../lib/plan';
import {
  checkFollowAllowed,
  followKey,
  getFollows,
  type FollowType,
} from '../../lib/follows';

type FollowPayload = {
  type: FollowType;
  id: string;
  nombre: string;
};

const FOLLOW_TYPES: FollowType[] = ['organismo', 'competidor', 'proveedor'];

async function authenticate(request: Request, locals: any): Promise<{ userId: string; plan: EffectivePlan } | null> {
  const auth = locals?.auth?.();
  if (!auth?.userId) return null;
  try {
    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const metadata = (user.publicMetadata || {}) as Record<string, any>;
    const plan = getUserPlan(metadata, user.username || undefined, auth.userId).plan;
    return { userId: auth.userId, plan };
  } catch {
    return null;
  }
}

function jsonError(payload: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const auth = await authenticate(request, locals);
    if (!auth) return jsonError({ error: 'No autenticado' }, 401);

    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const follows = getFollows(user.publicMetadata as Record<string, any>);

    return new Response(JSON.stringify({ ok: true, follows }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return jsonError({ error: message }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const auth = await authenticate(request, locals);
    if (!auth) return jsonError({ error: 'No autenticado' }, 401);

    const body = (await request.json()) as FollowPayload;
    if (!body?.type || !body?.id || !body?.nombre) {
      return jsonError({ error: 'Faltan campos: type, id, nombre' }, 400);
    }
    if (!FOLLOW_TYPES.includes(body.type)) {
      return jsonError({ error: 'type debe ser "organismo", "competidor" o "proveedor"' }, 400);
    }

    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const metadata = (user.publicMetadata || {}) as Record<string, any>;
    const follows = getFollows(metadata);
    const key = followKey(body.type);

    // Idempotente: si ya lo sigue, 200 sin duplicar (antes de los límites).
    const exists = follows[key].some((f) => f.id === body.id);
    if (exists) {
      return new Response(JSON.stringify({ ok: true, follows }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Límites por plan (Pro/Empresa/Admin vía feature 'alerts')
    const isPro = canAccessFeature(auth.plan, 'alerts');
    const check = checkFollowAllowed(body.type, follows, isPro);
    if (!check.ok) {
      return jsonError(check.payload, check.status);
    }

    follows[key].push({
      id: String(body.id),
      nombre: String(body.nombre),
      createdAt: new Date().toISOString(),
    });

    await client.users.updateUserMetadata(auth.userId, {
      publicMetadata: { ...metadata, follows },
    });

    return new Response(JSON.stringify({ ok: true, follows }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return jsonError({ error: message }, 500);
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    const auth = await authenticate(request, locals);
    if (!auth) return jsonError({ error: 'No autenticado' }, 401);

    const url = new URL(request.url);
    const type = url.searchParams.get('type') as FollowType | null;
    const id = url.searchParams.get('id');

    if (!type || !id || !FOLLOW_TYPES.includes(type)) {
      return jsonError({ error: 'Faltan o son inválidos: type, id' }, 400);
    }

    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const metadata = (user.publicMetadata || {}) as Record<string, any>;
    const follows = getFollows(metadata);

    const key = followKey(type);
    follows[key] = follows[key].filter((f) => f.id !== id);

    await client.users.updateUserMetadata(auth.userId, {
      publicMetadata: { ...metadata, follows },
    });

    return new Response(JSON.stringify({ ok: true, follows }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return jsonError({ error: message }, 500);
  }
};
