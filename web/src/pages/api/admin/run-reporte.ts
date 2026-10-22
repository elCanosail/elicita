/**
 * POST /api/admin/run-reporte
 * Endpoint interno para ejecutar manualmente el reporte semanal.
 *
 * Auth: IP allowlist (localhost / Tailscale) + admin secret opcional.
 */
import type { APIRoute } from 'astro';

const ADMIN_SECRET = import.meta.env.ADMIN_QUERY_SECRET;

function isAuthorized(request: Request): boolean {
  const clientIP = request.headers.get('x-real-ip')
    || request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || '';
  const isLocal = !clientIP
    || clientIP.startsWith('127.')
    || clientIP === '::1'
    || clientIP.startsWith('100.');

  if (!isLocal) return false;

  if (ADMIN_SECRET) {
    const auth = request.headers.get('authorization') || '';
    if (auth !== `Bearer ${ADMIN_SECRET}`) return false;
  }

  return true;
}

export const POST: APIRoute = async ({ request }) => {
  const t0 = Date.now();

  try {
    if (!isAuthorized(request)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json().catch(() => ({}));
    const dryRun = body.dryRun === true || body.dry_run === true;
    const onlyUser = body.onlyUser || body.only_user || null;

    const { runReporteSemanal } = await import('../../../../ingesta/reporte-semanal.js');
    const result = await runReporteSemanal({ dryRun, onlyUser });

    return new Response(JSON.stringify({
      ok: true,
      timing_ms: Date.now() - t0,
      result,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[run-reporte] Error:', err.message);
    return new Response(JSON.stringify({
      error: 'Error ejecutando reporte semanal',
      detail: err.message,
      timing_ms: Date.now() - t0,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
