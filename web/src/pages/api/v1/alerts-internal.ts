/**
 * GET /api/v1/alerts-internal?action=search&nif=A28389484&since=2026-08-24
 * Internal endpoint — searches recent contracts for alert matching.
 * localhost only.
 */
import type { APIRoute } from 'astro';
import { query, queryState } from '../../../lib/duckdb';

const LOCAL_ONLY = (request: Request) => {
  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
                   request.headers.get('x-real-ip')?.trim() || 'unknown';
  if (clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === 'unknown') return true;
  const host = request.headers.get('host') || '';
  return host.includes('localhost') || host.includes('127.0.0.1');
};

export const GET: APIRoute = async ({ request, url }) => {
  if (!LOCAL_ONLY(request)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }

  const params = new URL(url, 'http://localhost').searchParams;
  const action = params.get('action') || 'list';

  try {
    // Ensure table exists (en web-state)
    await queryState(`
      CREATE TABLE IF NOT EXISTS alertas (
        id VARCHAR PRIMARY KEY,
        user_id VARCHAR NOT NULL,
        email VARCHAR NOT NULL,
        nif_proveedor VARCHAR,
        cpv VARCHAR,
        organismo VARCHAR,
        created_at TIMESTAMP DEFAULT NOW(),
        last_sent_at TIMESTAMP,
        active BOOLEAN DEFAULT TRUE
      )
    `);

    if (action === 'search') {
      const nif = params.get('nif');
      const cpv = params.get('cpv');
      const organismo = params.get('organismo');
      const since = params.get('since') || '2026-01-01';

      if (!nif && !cpv && !organismo) {
        return new Response(JSON.stringify({ error: 'At least one filter required' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }

      // Build query against calidad table
      let sql = `SELECT objeto, organo_contratante,
        COALESCE(importe_adjudicacion, importe_sin_iva, 0) as importe,
        fecha_publicacion, estado, url, adjudicatario
        FROM calidad WHERE fecha_publicacion >= ?`;
      const p: any[] = [since];

      if (nif) { sql += ` AND nif_adjudicatario = ?`; p.push(nif); }
      if (cpv) { sql += ` AND CAST(cpv_principal AS VARCHAR) LIKE ?`; p.push(cpv + '%'); }
      if (organismo) { sql += ` AND organo_contratante LIKE ?`; p.push('%' + organismo + '%'); }

      sql += ` ORDER BY fecha_publicacion DESC LIMIT 50`;

      const contracts = await query(sql, p);

      return new Response(JSON.stringify({
        ok: true,
        contracts,
        count: contracts.length,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Default: list active alerts
    await queryState('CREATE INDEX IF NOT EXISTS idx_alertas_user ON alertas(user_id)');
    const alerts = await queryState(
      `SELECT id, user_id, email, nif_proveedor, cpv, organismo, created_at, last_sent_at, active
       FROM alertas WHERE active = true ORDER BY created_at DESC`,
    );

    return new Response(JSON.stringify({
      ok: true, alerts, count: alerts.length,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({
      ok: false, error: err?.message,
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};