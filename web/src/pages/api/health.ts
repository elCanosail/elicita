import type { APIRoute } from 'astro';
import fs from 'fs';
import path from 'path';

const HEALTH_FILE = path.join(process.cwd(), '..', 'ingesta', 'data', 'connector_health.json');
const CACHE_FILE = path.join(process.cwd(), '..', 'ingesta', 'data', 'api_cache.json');
const STATUS_FILE = path.join(process.cwd(), '..', 'ingesta', 'data', 'status.json');

export const GET: APIRoute = async ({ url }) => {
  const mode = url.searchParams.get('mode') || 'summary';
  const now = new Date().toISOString();

  // ── Load health data ──────────────────────────────────────────────
  let healthData: Record<string, any> = {};
  try {
    if (fs.existsSync(HEALTH_FILE)) {
      healthData = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf-8'));
    }
  } catch { /* empty */ }

  // ── Compute connector health counts (used by both modes) ───────────
  const entries = Object.values(healthData);
  const healthy = entries.filter((e: any) => e.consecutive_errors === 0 && e.last_success).length;
  const degraded = entries.filter((e: any) => e.consecutive_errors > 0 && e.consecutive_errors < 3).length;
  const failed = entries.filter((e: any) => e.consecutive_errors >= 3).length;
  const overall = failed > 0 ? 'degraded' : healthy > 0 ? 'healthy' : 'unknown';

  // ── Load status ───────────────────────────────────────────────────
  let status: any = {};
  try {
    if (fs.existsSync(STATUS_FILE)) {
      status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
    }
  } catch { /* empty */ }

  // ── Cache status ──────────────────────────────────────────────────
  let cacheStatus = 'unknown';
  let cacheAge = null;
  let cacheSize = 0;
  let cacheCount = 0;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const stat = fs.statSync(CACHE_FILE);
      cacheSize = stat.size;
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      cacheCount = data.total || 0;
      cacheAge = Math.floor((Date.now() - new Date(data.generated_at).getTime()) / 60000);
      cacheStatus = cacheAge < 360 ? 'fresh' : cacheAge < 720 ? 'stale' : 'expired';
    } else {
      cacheStatus = 'missing';
    }
  } catch {
    cacheStatus = 'error';
  }

  // ── Summary mode ──────────────────────────────────────────────────
  if (mode === 'summary') {
    return new Response(JSON.stringify({
      status: overall,
      connectors: {
        total: entries.length,
        healthy,
        degraded,
        failed,
      },
      cache: {
        status: cacheStatus,
        age_minutes: cacheAge,
        size_mb: (cacheSize / 1024 / 1024).toFixed(2),
        contratos: cacheCount,
      },
      last_cycle: status.ultima_ejecucion || null,
      cycle_duration_ms: status.cycle_duration_ms || null,
      timestamp: now,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // ── Detailed mode ─────────────────────────────────────────────────
  return new Response(JSON.stringify({
    status: overall,
    connectors: healthData,
    cache: {
      status: cacheStatus,
      age_minutes: cacheAge,
      size_mb: (cacheSize / 1024 / 1024).toFixed(2),
        contratos: cacheCount,
    },
    last_cycle: status,
    timestamp: now,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};