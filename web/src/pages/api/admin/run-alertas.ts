/**
 * POST /api/admin/run-alertas
 * Ejecuta el alertas-runner manualmente. Solo admins.
 *
 * Spawnea el runner como proceso hijo para evitar problemas de interop
 * ESM/CJS entre Astro y el script de ingesta (CommonJS puro).
 *
 * Nota: spawneado así, el runner intentará abrir DuckDB por su cuenta.
 * Si el servidor web ya mantiene la base abierta, la conexión puede fallar
 * por lock de DuckDB. En ese caso, la solución definitiva es ejecutar el
 * runner cuando el servidor no tenga la base abierta (scheduler) o hacer
 * que el endpoint use la conexión ya existente (requiere que el runner
 * esté dentro del bundle de web, lo cual va contra el requisito de
 * ubicarlo en ingesta/).
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

    const runnerPath = path.join(process.cwd(), '..', 'ingesta', 'alertas-runner.js');
    const cwd = path.join(process.cwd(), '..', 'ingesta');

    const { stdout, stderr } = await execFileAsync('node', [runnerPath], {
      cwd,
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const output = [stdout, stderr].filter(Boolean).join('\n');
    const summaryMatch = output.match(
      /Resumen: (\d+) enviados, (\d+) saltados, (\d+) errores, (\d+) contratos en (\d+)ms/
    );

    if (summaryMatch) {
      const [, sent, skipped, errors, totalContratos, durationMs] = summaryMatch;
      const ok = Number(errors) === 0;
      return new Response(
        JSON.stringify({
          ok,
          sent: Number(sent),
          skipped: Number(skipped),
          errors: Number(errors),
          totalContratos: Number(totalContratos),
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
