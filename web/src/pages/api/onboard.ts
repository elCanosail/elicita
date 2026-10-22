/**
 * POST /api/onboard
 * Body: { cif: "XXXXXXXXX", nombre?: "Mi Empresa SL" }
 * → 202 Accepted + { jobId }
 *
 * GET /api/onboard/status?jobId=xxx
 * → { status: "running" | "completed" | "error", cif?, error? }
 */

import type { APIRoute } from 'astro';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import crypto from 'crypto';

const PROFILES_DIR = path.resolve(process.cwd(), '..', 'ingesta', 'data', 'profiles');
const JOBS_FILE = path.resolve(process.cwd(), '..', 'ingesta', 'data', 'onboard_jobs.json');
const PROFILER_PATH = path.resolve(process.cwd(), '..', 'ingesta', 'connectors', 'profiler_v2.py');

function readJobs(): Record<string, { status: string; cif?: string; error?: string; createdAt: string; userId?: string }> {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJobs(jobs: Record<string, { status: string; cif?: string; error?: string; createdAt: string; userId?: string }>) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function validarCIFoNIF(id: string): boolean {
  const v = id.trim().toUpperCase();
  // CIF: letra + 8 dígitos (B12345678)
  if (/^[A-Z]\d{8}$/.test(v)) return true;
  // CIF con letra control: letra + 7 dígitos + letra (A1234567B)
  if (/^[A-Z]\d{7}[A-Z]$/.test(v)) return true;
  // NIF: 8 dígitos + letra (12345678A)
  if (/^\d{8}[A-Z]$/.test(v)) return true;
  // NIE: X/Y/Z + 7 dígitos + letra (X1234567A)
  if (/^[XYZ]\d{7}[A-Z]$/.test(v)) return true;
  return false;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const userId = (locals as any).auth?.()?.userId;
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Autenticación requerida' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { cif?: string; nombre?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'JSON inválido' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cif = (body.cif || '').trim().toUpperCase();
  const nombre = (body.nombre || '').trim();

  if (!validarCIFoNIF(cif)) {
    return new Response(JSON.stringify({ error: 'Formato no válido. Introduce un CIF (ej: B12345678) o NIF (ej: 12345678A)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verifica si ya existe perfil
  const profilePath = path.join(PROFILES_DIR, `${cif}.json`);
  if (fs.existsSync(profilePath)) {
    const existing = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    return new Response(JSON.stringify({ ok: true, alreadyExists: true, data: existing }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Crear job
  const jobId = crypto.randomUUID();
  const jobs = readJobs();
  jobs[jobId] = { status: 'running', cif, userId, createdAt: new Date().toISOString() };
  writeJobs(jobs);

  // Asegurar que existe el directorio de perfiles
  fs.mkdirSync(PROFILES_DIR, { recursive: true });

  // Lanzar profiler en background
  const args = ['profiler_v2.py', '--cif', cif, '--output', profilePath];
  if (nombre) args.push('--nombre', nombre);

  const proc = spawn('python3', args, {
    cwd: path.dirname(PROFILER_PATH),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

  proc.on('close', (code: number) => {
    const jobs2 = readJobs();
    if (code === 0 && fs.existsSync(profilePath)) {
      jobs2[jobId] = { status: 'completed', cif, createdAt: jobs2[jobId]?.createdAt || new Date().toISOString() };
    } else {
      jobs2[jobId] = {
        status: 'error',
        cif,
        createdAt: jobs2[jobId]?.createdAt || new Date().toISOString(),
        error: stderr.slice(-500) || `Profiler terminó con código ${code}`,
      };
    }
    writeJobs(jobs2);
  });

  proc.unref();

  return new Response(JSON.stringify({ ok: true, jobId, cif, status: 'running' }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const GET: APIRoute = async ({ url, locals }) => {
  const userId = (locals as any).auth?.()?.userId;
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Autenticación requerida' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const jobId = url.searchParams.get('jobId');
  if (!jobId) {
    return new Response(JSON.stringify({ error: 'Falta jobId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const jobs = readJobs();
  const job = jobs[jobId];
  if (!job || job.userId !== userId) {
    return new Response(JSON.stringify({ error: 'Job no encontrado' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let data = null;
  if (job.status === 'completed' && job.cif) {
    const profilePath = path.join(PROFILES_DIR, `${job.cif}.json`);
    if (fs.existsSync(profilePath)) {
      data = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    }
  }

  return new Response(JSON.stringify({ ok: true, ...job, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
