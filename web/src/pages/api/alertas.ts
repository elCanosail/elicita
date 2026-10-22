/**
 * GET  /api/alertas — Devuelve config de alertas del usuario autenticado
 * POST /api/alertas — Guarda config de alertas en Clerk publicMetadata
 * Auth: Clerk session OR Bearer API Key
 */
import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import { canAccessFeature, getUserPlan, getMaxAlerts } from '../../lib/plan';
import { hashApiKey, isValidApiKeyFormat, getApiKeyByHash, updateLastUsed } from '../../lib/api-keys';

async function authenticate(request: Request, locals: any): Promise<{ userId: string; plan: string } | null> {
  // Try API Key first (Authorization: Bearer ***)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const key = authHeader.slice(7);
    if (isValidApiKeyFormat(key)) {
      const keyHash = hashApiKey(key);
      const apiKey = await getApiKeyByHash(keyHash);
      if (apiKey && !apiKey.revoked) {
        updateLastUsed(apiKey.id).catch(() => {});
        try {
          const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
          const user = await client.users.getUser(apiKey.userId);
          const metadata = (user.publicMetadata || {}) as Record<string, any>;
          const plan = metadata?.plan || 'free';
          return { userId: apiKey.userId, plan };
        } catch {
          return null;
        }
      }
    }
  }

  // Try Clerk session
  const auth = locals?.auth?.();
  if (auth?.userId) {
    try {
      const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
      const user = await client.users.getUser(auth.userId);
      const metadata = (user.publicMetadata || {}) as Record<string, any>;
      const plan = metadata?.plan || 'free';
      return { userId: auth.userId, plan };
    } catch {
      return null;
    }
  }
  return null;
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const auth = await authenticate(request, locals);
    const userId = auth?.userId;
    if (!userId) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(userId);
    const meta = (user.publicMetadata as Record<string, any>) || {};
    const alertas = meta.alertas || null;
    const email = user.emailAddresses?.[0]?.emailAddress || '';

    return new Response(JSON.stringify({ ok: true, alertas, email }), {
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
    const userId = auth?.userId;
    if (!userId) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(userId);
    const userPlan = getUserPlan(
      (user.publicMetadata as Record<string, any>) || {},
      user.username || undefined,
      userId,
    );

    const body = await request.json();
    const cpvs = Array.isArray(body.cpvs) ? body.cpvs : [];
    const organismos = Array.isArray(body.organismos) ? body.organismos : [];
    const keywords = Array.isArray(body.keywords) ? body.keywords : [];
    const frecuencia = body.frecuencia === 'diario' ? 'diario' : '4h';
    const activo = body.activo !== false;

    const competidores = Array.isArray(body.competidores) ? body.competidores : [];

    const alertas = { cpvs, organismos, keywords, competidores, frecuencia, activo };

    // Free tier enforcement: 1 alert only
    const maxAlerts = userPlan.maxAlerts ?? getMaxAlerts(userPlan.plan);
    const hasActiveAlert =
      (alertas.cpvs.length > 0 ||
        alertas.organismos.length > 0 ||
        alertas.keywords.length > 0) &&
      alertas.activo !== false;

    // Competitor alerts: Pro/Empresa only
    const competitorFeatureEnabled = canAccessFeature(userPlan.plan, 'alerts') && userPlan.plan !== 'free';

    if (maxAlerts === 0 && hasActiveAlert) {
      return new Response(
        JSON.stringify({
          error: 'Tu plan no incluye alertas',
          upgrade: '/precios',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (maxAlerts > 0 && Number.isFinite(maxAlerts) && hasActiveAlert) {
      const alertCount = [alertas.cpvs, alertas.organismos, alertas.keywords].filter(
        (arr) => arr.length > 0,
      ).length;
      if (alertCount > maxAlerts) {
        return new Response(
          JSON.stringify({
            error: 'Límite de alertas alcanzado',
            upgrade: '/precios',
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
    }

    if (!competitorFeatureEnabled && alertas.competidores.length > 0) {
      return new Response(
        JSON.stringify({
          error: 'Las alertas de competidores requieren plan Pro o Empresa',
          upgrade: '/precios',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    await client.users.updateUserMetadata(userId, {
      publicMetadata: { alertas },
    });

    return new Response(JSON.stringify({ ok: true, alertas }), {
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
