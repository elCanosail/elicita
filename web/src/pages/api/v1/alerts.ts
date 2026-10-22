/**
 * GET /api/v1/alerts
 * List alerts for authenticated user
 * POST /api/v1/alerts
 * Create a new alert
 * DELETE /api/v1/alerts?id=xxx
 * Delete an alert
 *
 * Auth: Clerk session required
 * Plans: free (1 alert), pro (10), enterprise (unlimited)
 */
import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import { queryState } from '../../../lib/duckdb';
import { queryWrite } from '../../../lib/duckdb-write';

interface AlertConfig {
  id: string;
  user_id: string;
  email: string;
  nif_proveedor: string | null;
  cpv: string | null;
  organismo: string | null;
  created_at: string;
  last_sent_at: string | null;
  active: boolean;
}

async function getUserPlan(locals: any, request: Request): Promise<{ userId: string; email: string; plan: string } | null> {
  const auth = locals?.auth?.();
  if (!auth?.userId) return null;

  try {
    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const metadata = (user.publicMetadata || {}) as Record<string, any>;
    const plan = metadata?.plan || 'free';

    // Get primary email
    const email = user.emailAddresses?.find((e: any) => e.id === user.primaryEmailAddressId)?.emailAddress || '';

    return { userId: auth.userId, email, plan };
  } catch {
    return null;
  }
}

const PLAN_LIMITS: Record<string, number> = {
  free: 1,
  pro: 10,
  empresa: 50,
  developer: 10,
  enterprise: 999,
};

export const GET: APIRoute = async ({ request, locals }) => {
  const auth = await getUserPlan(locals, request);
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const alerts = await queryState(
      `SELECT * FROM alertas WHERE user_id = ? ORDER BY created_at DESC`,
      [auth.userId],
    );

    return new Response(JSON.stringify({
      ok: true,
      alerts,
      plan: auth.plan,
      limit: PLAN_LIMITS[auth.plan] ?? 1,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await getUserPlan(locals, request);
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const { nif_proveedor, cpv, organismo } = body as {
      nif_proveedor?: string;
      cpv?: string;
      organismo?: string;
    };

    // Validate at least one filter
    if (!nif_proveedor && !cpv && !organismo) {
      return new Response(JSON.stringify({ error: 'Al menos un filtro requerido (nif_proveedor, cpv, o organismo)' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check plan limits
    const existing = await queryState(
      `SELECT COUNT(*) as count FROM alertas WHERE user_id = ? AND active = true`,
      [auth.userId],
    );
    const count = existing[0]?.count || 0;
    const limit = PLAN_LIMITS[auth.plan] ?? 1;

    if (count >= limit) {
      return new Response(JSON.stringify({
        error: `Límite alcanzado (${limit} alertas para plan ${auth.plan})`,
        upgrade_url: '/cuenta/plan',
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Create alert
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await queryWrite(
      `INSERT INTO alertas (id, user_id, email, nif_proveedor, cpv, organismo, created_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, true)`,
      [id, auth.userId, auth.email, nif_proveedor || null, cpv || null, organismo || null, now],
    );

    return new Response(JSON.stringify({
      ok: true,
      alert: {
        id,
        user_id: auth.userId,
        email: auth.email,
        nif_proveedor: nif_proveedor || null,
        cpv: cpv || null,
        organismo: organismo || null,
        created_at: now,
        last_sent_at: null,
        active: true,
      },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const DELETE: APIRoute = async ({ request, locals, url }) => {
  const auth = await getUserPlan(locals, request);
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const id = url.searchParams.get('id');
  if (!id) {
    return new Response(JSON.stringify({ error: 'id requerido' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await queryWrite(
      `DELETE FROM alertas WHERE id = ? AND user_id = ?`,
      [id, auth.userId],
    );

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};