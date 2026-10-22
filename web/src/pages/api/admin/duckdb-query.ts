/**
 * POST /api/admin/duckdb-query
 * Endpoint interno para ejecutar queries SELECT contra DuckDB desde procesos externos
 * (scheduler, reporte semanal, etc.) sin conflictos de lock.
 *
 * Auth: dirección de socket real (loopback / Tailscale) + IP reenviada local si hay proxy + admin secret opcional.
 */

import type { APIRoute } from 'astro';
import { query, queryReadOnly } from '../../../lib/duckdb';

const ADMIN_SECRET = import.meta.env.ADMIN_SECRET || '';

function isLocalIp(ip: string): boolean {
  return ip.startsWith('127.') || ip === '::1' || ip.startsWith('100.'); // loopback / Tailscale
}

function isAuthorized(request: Request, clientAddress?: string): boolean {
  // 1) Ancla de confianza: dirección REAL del socket (node adapter). Las cabeceras
  //    (x-real-ip / cf-connecting-ip) son dato de contexto, nunca prueba de origen:
  //    cualquier proceso local puede escribirlas y vía nginx/CF llevan la del cliente.
  let peer = '';
  try {
    peer = clientAddress || '';
  } catch {
    peer = ''; // adapter sin soporte (no debería ocurrir con node adapter)
  }

  if (peer) {
    if (!isLocalIp(peer)) return false;
    // Tráfico proxyado (nginx/CF): la IP reenviada, si viene, debe ser local.
    const forwarded = request.headers.get('x-real-ip')
      || request.headers.get('cf-connecting-ip')
      || '';
    if (forwarded && !isLocalIp(forwarded)) return false;
  } else {
    // Fallback (comportamiento previo) solo si el adapter no expone clientAddress.
    const clientIP = request.headers.get('x-real-ip')
      || request.headers.get('cf-connecting-ip')
      || '';
    if (!clientIP || !isLocalIp(clientIP)) return false;
  }

  if (ADMIN_SECRET) {
    const auth = request.headers.get('authorization') || '';
    if (auth !== `Bearer ${ADMIN_SECRET}`) return false;
  }

  return true;
}

const MAX_ROWS = 5000;
const MAX_SQL_LEN = 20000;

function isReadOnlySql(sql: string): boolean {
  const normalized = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toLowerCase();
  // Debe empezar por SELECT/WITH (solo lectura).
  if (!/^(with\s|select\s)/.test(normalized)) return false;
  const forbidden = /\b(insert|update|delete|drop|alter|truncate|copy|attach|detach|create|pragma\s+write|checkpoint|replace|export|import|install|load|call)\b/;
  // Bloquear multi-statement (separador ;) — solo un statement.
  const stripped = normalized.replace(/;[\s]*$/g, '');
  if (stripped.includes(';')) return false;
  if (forbidden.test(normalized)) return false;
  return true;
}

export const POST: APIRoute = async (context) => {
  const { request } = context;
  let peerAddress = '';
  try {
    peerAddress = context.clientAddress || '';
  } catch {
    peerAddress = '';
  }
  try {
    if (!isAuthorized(request, peerAddress)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json().catch(() => ({}));
    const sql = String(body.sql || '').trim();
    if (!sql) {
      return new Response(JSON.stringify({ error: 'Falta sql' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (sql.length > MAX_SQL_LEN) {
      return new Response(JSON.stringify({ error: 'SQL demasiado largo' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!isReadOnlySql(sql)) {
      return new Response(JSON.stringify({ error: 'Solo se permiten consultas SELECT de solo lectura' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const rows = await queryReadOnly(sql);
    const capped = rows.slice(0, MAX_ROWS);
    return new Response(JSON.stringify({ ok: true, rows: capped, truncated: rows.length > MAX_ROWS }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[duckdb-query] Error:', err.message);
    return new Response(JSON.stringify({ error: 'Error ejecutando query', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
