/**
 * POST /api/admin/run-matching
 * Ejecuta el matching-runner manualmente. Solo admins.
 */
import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ADMIN_IDS, ADMIN_USERNAMES } from '../../../lib/plan';

const execFileAsync = promisify(execFile);

function isAdmin(user: any): boolean {
  if (!user) return false;
  return ADMIN_USERNAMES.includes(user.username || '') || ADMIN_IDS.includes(user.id);
}

export const POST: APIRoute = async ({ locals }) => {
  try {
    const auth = (locals as any)?.auth?.();
    const userId = auth?.userId;

    if (!userId) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(userId);

    if (!isAdmin(user)) {
      return new Response(JSON.stringify({ error: 'Acceso denegado' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const runnerPath = path.join(process.cwd(), '..', 'ingesta', 'matching-runner.js');
    const cwd = path.join(process.cwd(), '..', 'ingesta');

    const { stdout, stderr } = await execFileAsync('node', [runnerPath], {
      cwd,
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const output = [stdout, stderr].filter(Boolean).join('\n');
    const summaryMatch = output.match(
      /Resumen: (\d+) usuarios, (\d+) matches, (\d+) emails, (\d+) errores en (\d+)ms/
    );

    if (summaryMatch) {
      const [, usuarios, matches, emails, errors, durationMs] = summaryMatch;
      const ok = Number(errors) === 0;
      return new Response(
        JSON.stringify({
          ok,
          usuarios_procesados: Number(usuarios),
          contratos_matcheados: Number(matches),
          emails_enviados: Number(emails),
          errores: Number(errors),
          durationMs: Number(durationMs),
          logTail: output.split('\n').slice(-20).join('\n'),
        }),
        {
          status: ok ? 200 : 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({
        ok: false,
        error: 'No se pudo parsear el resumen del runner',
        output,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
