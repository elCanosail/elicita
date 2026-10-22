/**
 * GET /api/profile?cif=XXXXXXXXX
 *
 * Devuelve el perfil de cliente.
 * Prioridad:
 *   1. ?cif=XXX en query param
 *   2. publicMetadata.cif del usuario Clerk autenticado
 *   3. Primer perfil disponible en profiles/
 */

import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import fs from 'fs';
import path from 'path';

const PROFILES_DIR = path.resolve(process.cwd(), '..', 'ingesta', 'data', 'profiles');

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    // 1. Query param ?cif=
    let cif = url.searchParams.get('cif')?.trim().toUpperCase() || '';

    // 2. Clerk publicMetadata.cif del usuario autenticado
    if (!cif) {
      try {
        const auth = (locals as any).auth?.();
        const userId = auth?.userId;
        if (userId) {
          const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
          const user = await client.users.getUser(userId);
          const userCif = (user.publicMetadata as any)?.cif;
          if (userCif) cif = String(userCif).toUpperCase();
        }
      } catch {}
    }

    let profilePath: string | null = null;

    if (cif) {
      profilePath = path.join(PROFILES_DIR, `${cif}.json`);
      if (!fs.existsSync(profilePath)) profilePath = null;
    }

    // Sin CIF o sin perfil → el usuario debe hacer onboard

    if (!profilePath || !fs.existsSync(profilePath)) {
      // No CIF or no profile yet — return empty data instead of 404.
      // The frontend handles this gracefully with the setup CTA.
      return new Response(JSON.stringify({
        ok: true,
        generado: null,
        data: null,
        needsOnboard: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = fs.readFileSync(profilePath, 'utf-8');
    const profile = JSON.parse(raw);

    // Strip borme_* keys from fuentes — they're not contract sources
    const responseData = { ...profile };
    if (responseData.fuentes && typeof responseData.fuentes === 'object') {
      responseData.fuentes = Object.fromEntries(
        Object.entries(responseData.fuentes).filter(([k]) => !k.startsWith('borme'))
      );
    }

    return new Response(JSON.stringify({
      ok: true,
      generado: profile.generado,
      data: responseData,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return new Response(JSON.stringify({
      error: 'Error leyendo el perfil',
      detail: message,
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

/**
 * PATCH /api/profile
 * Body: { cif?: string, cpvs_seleccionados?: string[], onboarded?: boolean }
 * Guarda la selección de CPVs del usuario en el perfil y actualiza Clerk metadata con el CIF
 * Si onboarded=false, solo actualiza metadata sin requerir CIF
 */
export const PATCH: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const onboarded = body.onboarded;
    const cif = (body.cif || '').trim().toUpperCase();
    const cpvs = Array.isArray(body.cpvs_seleccionados) ? body.cpvs_seleccionados : [];

    // Handle skip-onboarding: just mark as not onboarded, no CIF required
    if (onboarded === false) {
      try {
        const auth = (locals as any).auth?.();
        const userId = auth?.userId;
        if (userId) {
          const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
          await client.users.updateUserMetadata(userId, {
            publicMetadata: { onboarded: false },
          });
        }
      } catch (clerkErr) {
        console.warn('[profile PATCH] Could not update Clerk metadata (skip):', clerkErr);
      }
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!cif) {
      return new Response(JSON.stringify({ error: 'CIF requerido' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const profilePath = path.join(PROFILES_DIR, `${cif}.json`);
    fs.mkdirSync(PROFILES_DIR, { recursive: true });

    // Load existing profile or create minimal one (for users without history)
    let profile: Record<string, any>;
    if (fs.existsSync(profilePath)) {
      profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    } else {
      profile = {
        cif,
        empresa: body.nombre || cif,
        generado: new Date().toISOString(),
        adjudicaciones_total: 0,
        cpvs_activos: [],
        competidores: [],
        source: 'manual',
      };
    }

    profile.cpvs_seleccionados = cpvs;
    profile.cpvs_seleccionados_at = new Date().toISOString();
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    // Update Clerk publicMetadata with CIF so middleware/dashboard can detect onboard status
    try {
      const auth = (locals as any).auth?.();
      const userId = auth?.userId;
      if (userId) {
        const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
        await client.users.updateUserMetadata(userId, {
          publicMetadata: { cif, onboarded: true },
        });
      }
    } catch (clerkErr) {
      console.warn('[profile PATCH] Could not update Clerk metadata:', clerkErr);
      // Non-fatal — profile is saved, CIF write is best-effort
    }

    return new Response(JSON.stringify({ ok: true, saved: cpvs.length }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
