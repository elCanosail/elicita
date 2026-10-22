/**
 * POST /api/admin/write-matching
 * Endpoint interno para escribir resultados de matching en ia_matching_results.
 * Usado por matching-runner.js cuando no puede abrir DuckDB en modo escritura
 * porque el servidor web mantiene el lock de escritura.
 *
 * Auth: admin secret opcional + IP allowlist.
 */
import type { APIRoute } from 'astro';
import { queryState } from '../../../lib/duckdb';

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

interface MatchRecord {
  id_contrato: string;
  user_id: string;
  score: number;
  motivo: string;
  enviado_email?: boolean;
  fecha_envio?: string | null;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    if (!isAuthorized(request)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json().catch(() => ({}));
    const matches: MatchRecord[] = Array.isArray(body.matches) ? body.matches : [];
    if (!matches.length) {
      return new Response(JSON.stringify({ ok: true, inserted: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const now = new Date().toISOString();
    let inserted = 0;

    for (const m of matches) {
      const idContrato = String(m.id_contrato || '').trim();
      const userId = String(m.user_id || '').trim();
      if (!idContrato || !userId) continue;

      const score = Math.max(0, Math.min(100, Number(m.score) || 0));
      const motivo = String(m.motivo || '').slice(0, 300);
      const enviado = m.enviado_email === true;
      const fechaEnvio = enviado ? (m.fecha_envio || now) : null;

      await queryState(
        `INSERT INTO ia_matching_results (id_contrato, user_id, score, motivo, fecha_match, enviado_email, fecha_envio)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id_contrato, user_id) DO UPDATE SET
           score = EXCLUDED.score,
           motivo = EXCLUDED.motivo,
           fecha_match = EXCLUDED.fecha_match,
           enviado_email = EXCLUDED.enviado_email,
           fecha_envio = EXCLUDED.fecha_envio`,
        [idContrato, userId, score, motivo, now, enviado, fechaEnvio]
      );
      inserted++;
    }

    return new Response(JSON.stringify({ ok: true, inserted }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[write-matching] Error:', err.message);
    return new Response(JSON.stringify({ error: 'Error guardando matches', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
