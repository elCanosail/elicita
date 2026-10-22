/**
 * GET/POST /api/ai/perfil
 * Gestiona el perfil IA de un usuario para matching de licitaciones.
 * GET: ?user_id=xxx — devuelve el perfil
 * POST: guarda/actualiza el perfil (upsert)
 */
import type { APIRoute } from 'astro';
import { queryState } from '../../../lib/duckdb';
import { clerkClient } from '@clerk/astro/server';
import { ADMIN_IDS, ADMIN_USERNAMES } from '../../../lib/plan';

function isAdmin(user: any): boolean {
  if (!user) return false;
  return ADMIN_USERNAMES.includes(user.username || '') || ADMIN_IDS.includes(user.id);
}

function sanitizeTextArray(arr: any): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => String(x || '').trim())
    .filter((x) => x.length > 0);
}

function normNumber(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function getClerkUser(requestUserId: string | null, locals: any) {
  try {
    const auth = (locals as any)?.auth?.();
    const userId = auth?.userId;
    if (!userId) return null;
    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(userId);
    return user;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const user = await getClerkUser(null, locals);
    const requestedUserId = url.searchParams.get('user_id')?.trim();
    const currentUserId = (user as any)?.id;

    if (!currentUserId) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const targetUserId = requestedUserId || currentUserId;

    if (targetUserId !== currentUserId && !isAdmin(user)) {
      return new Response(JSON.stringify({ error: 'No puedes ver perfiles de otros usuarios' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const rows = await queryState(
      `SELECT user_id, email, nombre, cpvs, organismos, fuentes, importe_min, importe_max, sectores, activo, created_at, updated_at
       FROM ia_perfiles WHERE user_id = ? LIMIT 1`,
      [targetUserId]
    );

    return new Response(
      JSON.stringify({
        ok: true,
        perfil: rows[0] || null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('[ai/perfil GET] Error:', err.message);
    return new Response(
      JSON.stringify({ error: 'Error leyendo perfil', detail: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = await getClerkUser(null, locals);
    const currentUserId = (user as any)?.id;

    if (!currentUserId) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Body JSON inválido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const targetUserId = (body.user_id || currentUserId).trim();
    if (!targetUserId) {
      return new Response(JSON.stringify({ error: 'user_id requerido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (targetUserId !== currentUserId && !isAdmin(user)) {
      return new Response(JSON.stringify({ error: 'No puedes modificar perfiles de otros usuarios' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const cpvs = sanitizeTextArray(body.cpvs);
    const organismos = sanitizeTextArray(body.organismos);
    const fuentes = sanitizeTextArray(body.fuentes);
    const sectores = sanitizeTextArray(body.sectores);
    const importeMin = normNumber(body.importe_min);
    const importeMax = normNumber(body.importe_max);
    const activo = body.activo === undefined ? true : !!body.activo;
    const email = body.email ? String(body.email).trim() : null;
    const nombre = body.nombre ? String(body.nombre).trim() : null;

    const sql = `
      INSERT INTO ia_perfiles (user_id, email, nombre, cpvs, organismos, fuentes, importe_min, importe_max, sectores, activo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), now())
      ON CONFLICT (user_id) DO UPDATE SET
        email = EXCLUDED.email,
        nombre = EXCLUDED.nombre,
        cpvs = EXCLUDED.cpvs,
        organismos = EXCLUDED.organismos,
        fuentes = EXCLUDED.fuentes,
        importe_min = EXCLUDED.importe_min,
        importe_max = EXCLUDED.importe_max,
        sectores = EXCLUDED.sectores,
        activo = EXCLUDED.activo,
        updated_at = now()
    `;

    await queryState(sql, [
      targetUserId,
      email,
      nombre,
      cpvs,
      organismos,
      fuentes,
      importeMin,
      importeMax,
      sectores,
      activo,
    ]);

    return new Response(
      JSON.stringify({ ok: true, user_id: targetUserId }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('[ai/perfil POST] Error:', err.message);
    return new Response(
      JSON.stringify({ error: 'Error guardando perfil', detail: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
