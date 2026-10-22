/**
 * GET    /api/saved-searches — Devuelve búsquedas guardadas del usuario
 * POST   /api/saved-searches — Guarda una búsqueda
 * DELETE /api/saved-searches — Elimina una búsqueda guardada por id
 * Auth: Clerk session
 */
import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import { getUserPlan, canAccessFeature, type EffectivePlan } from '../../lib/plan';

const MAX_SAVED_SEARCHES_FREE = 5;

interface SavedSearch {
  id: string;
  name: string;
  query: string;
  filters: Record<string, any>;
  createdAt: string;
}

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

function getSavedSearches(metadata: Record<string, any>): SavedSearch[] {
  return Array.isArray(metadata?.savedSearches) ? metadata.savedSearches : [];
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const auth = await authenticate(request, locals);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const saved = getSavedSearches(user.publicMetadata as Record<string, any>);

    return new Response(JSON.stringify({ ok: true, savedSearches: saved }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const auth = await authenticate(request, locals);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = (await request.json()) as Partial<SavedSearch>;
    if (!body?.name || typeof body.query !== 'string') {
      return new Response(JSON.stringify({ error: 'Faltan campos: name, query' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const metadata = (user.publicMetadata || {}) as Record<string, any>;
    const saved = getSavedSearches(metadata);

    const isPro = canAccessFeature(auth.plan, 'buscador_unlimited');
    if (!isPro && saved.length >= MAX_SAVED_SEARCHES_FREE) {
      return new Response(
        JSON.stringify({
          error: 'Límite de búsquedas guardadas alcanzado',
          upgrade: '/precios',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const newSearch: SavedSearch = {
      id: body.id || crypto.randomUUID(),
      name: body.name.trim(),
      query: body.query,
      filters: body.filters || {},
      createdAt: new Date().toISOString(),
    };

    // Evitar duplicados por id
    const existingIndex = saved.findIndex((s) => s.id === newSearch.id);
    if (existingIndex >= 0) {
      saved[existingIndex] = newSearch;
    } else {
      saved.push(newSearch);
    }

    await client.users.updateUserMetadata(auth.userId, {
      publicMetadata: { ...metadata, savedSearches: saved },
    });

    return new Response(JSON.stringify({ ok: true, savedSearches: saved }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    const auth = await authenticate(request, locals);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ error: 'Falta id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const metadata = (user.publicMetadata || {}) as Record<string, any>;
    const saved = getSavedSearches(metadata).filter((s) => s.id !== id);

    await client.users.updateUserMetadata(auth.userId, {
      publicMetadata: { ...metadata, savedSearches: saved },
    });

    return new Response(JSON.stringify({ ok: true, savedSearches: saved }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
