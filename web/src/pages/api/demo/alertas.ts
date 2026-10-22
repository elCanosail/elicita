import type { APIRoute } from 'astro';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../../../lib/api-auth';

const DEMO_ALERTS_PATH = path.join(
  process.cwd(),
  '..',
  'ingesta',
  'data',
  'demo',
  'demo_alerts.json'
);

export const GET: APIRoute = async ({ locals }) => {
  const { error } = requireAuth(locals);
  if (error) return error;
  try {
    if (!fs.existsSync(DEMO_ALERTS_PATH)) {
      return new Response(JSON.stringify({
        total: 0,
        no_leidas: 0,
        alertas: [],
        demo: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const raw = fs.readFileSync(DEMO_ALERTS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const alertas = data.alertas || [];
    const noLeidas = alertas.filter((a: any) => !a.leida).length;

    return new Response(JSON.stringify({
      total: alertas.length,
      no_leidas: noLeidas,
      alertas,
      demo: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return new Response(JSON.stringify({
      error: 'Error leyendo alertas demo',
      detail: message,
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
