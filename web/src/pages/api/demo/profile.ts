import type { APIRoute } from 'astro';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../../../lib/api-auth';

const DEMO_PROFILE_PATH = path.join(
  process.cwd(),
  '..',
  'ingesta',
  'data',
  'demo',
  'demo_profile.json'
);

export const GET: APIRoute = async ({ locals }) => {
  const { error } = requireAuth(locals);
  if (error) return error;
  try {
    if (!fs.existsSync(DEMO_PROFILE_PATH)) {
      return new Response(JSON.stringify({
        error: 'Perfil demo no encontrado',
        detail: 'El archivo demo_profile.json no existe en ingesta/data/demo/',
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const raw = fs.readFileSync(DEMO_PROFILE_PATH, 'utf-8');
    const profile = JSON.parse(raw);

    return new Response(JSON.stringify({
      ok: true,
      generado: profile.generado,
      demo: true,
      data: profile,
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
      error: 'Error leyendo el perfil demo',
      detail: message,
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
