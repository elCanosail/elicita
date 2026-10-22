// Endpoint interno para recargar DuckDB desde los JSON de ingesta
// Cierra la conexión Node, ejecuta el script Python, y reabre
import type { APIRoute } from 'astro';
import { exec } from 'child_process';
import { promisify } from 'util';
import { closeDuckDB } from '../../lib/duckdb';
import { adminGuard } from '../../lib/internal-guard';

const execAsync = promisify(exec);

export const POST: APIRoute = async ({ request }) => {
  // Endpoint destructivo: exige el secreto admin (ADMIN_API_KEY /
  // ADMIN_SECRET). Sin secreto definido queda fail-closed (403).
  const denied = adminGuard(request);
  if (denied) return denied;

  const t0 = Date.now();

  try {
    // Cerrar la conexión DuckDB del proceso Node para liberar el lock
    console.log('[reload] Cerrando conexión DuckDB...');
    closeDuckDB();

    // Esperar un momento para que el OS libere el file handle
    await new Promise(r => setTimeout(r, 500));

    // Ejecutar el script Python
    console.log('[reload] Ejecutando load-json-to-duckdb.py...');
    const { stdout, stderr } = await execAsync(
      'python3 /root/.openclaw/workspace/projects/elicita/ingesta/scripts/load-json-to-duckdb.py',
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
    );

    const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
    console.log('[reload] Script completado:', output.slice(-200));

    // La conexión se reabrirá automáticamente en el próximo query (singleton init)
    return new Response(JSON.stringify({
      success: true,
      timing_ms: Date.now() - t0,
      output: output.slice(-2000),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[reload] Error:', err.message);

    // La conexión se reabrirá automáticamente
    return new Response(JSON.stringify({
      error: err.message,
      timing_ms: Date.now() - t0,
      stdout: err.stdout?.slice(-1000) || '',
      stderr: err.stderr?.slice(-1000) || '',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};