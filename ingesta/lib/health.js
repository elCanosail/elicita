/**
 * health.js — Salud de conectores y cache de emergencia para Elicita
 * ═══════════════════════════════════════════════════════════════════
 *
 * Lección ea-cpp: Degrada, no se rompe.
 *
 * Cada conector registra su estado: último éxito, último error, conteos.
 * El scheduler consulta health antes de ejecutar.
 * Si api_cache.json falla, se sirve api_cache.prev.json.
 *
 * Uso:
 *   const health = require('./lib/health');
 *   health.record('ted', { status: 'ok', count: 3490, duration_ms: 45000 });
 *   health.record('catalunya', { status: 'error', error: 'HTTP 503', duration_ms: 2000 });
 *   health.getStatus() → { ted: { ... }, catalunya: { ... }, ... }
 *   health.getSummary() → { healthy: 10, degraded: 2, failed: 1, last_run: '...' }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const HEALTH_FILE = path.join(__dirname, '..', 'data', 'connector_health.json');
const CACHE_FILE  = path.join(__dirname, '..', 'data', 'api_cache.json');
const CACHE_PREV  = path.join(__dirname, '..', 'data', 'api_cache.prev.json');

// ── Estado en memoria ──────────────────────────────────────────────────
const connectors = {};

function record(connectorName, result) {
  const now = new Date().toISOString();
  if (!connectors[connectorName]) {
    connectors[connectorName] = {
      name: connectorName,
      total_runs: 0,
      total_success: 0,
      total_errors: 0,
      last_success: null,
      last_error: null,
      last_error_msg: null,
      last_count: 0,
      last_duration_ms: 0,
      consecutive_errors: 0,
    };
  }

  const entry = connectors[connectorName];
  entry.total_runs += 1;
  entry.last_duration_ms = result.duration_ms || 0;

  if (result.status === 'ok') {
    entry.total_success += 1;
    entry.last_success = now;
    entry.last_count = result.count || 0;
    entry.consecutive_errors = 0;
    entry.last_error_msg = null;
  } else {
    entry.total_errors += 1;
    entry.last_error = now;
    entry.last_error_msg = result.error || 'unknown error';
    entry.consecutive_errors += 1;
  }

  // Persistir
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(connectors, null, 2));
  } catch (_) {
    // No romper el ciclo por un error de escritura de health
  }

  return entry;
}

function getStatus() {
  // Cargar desde archivo si memoria vacía (cold start)
  if (Object.keys(connectors).length === 0) {
    try {
      if (fs.existsSync(HEALTH_FILE)) {
        const data = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf-8'));
        Object.assign(connectors, data);
      }
    } catch (_) {}
  }
  return { ...connectors };
}

function getSummary() {
  const status = getStatus();
  const entries = Object.values(status);
  const healthy   = entries.filter(e => e.consecutive_errors === 0 && e.last_success).length;
  const degraded  = entries.filter(e => e.consecutive_errors > 0 && e.consecutive_errors < 3).length;
  const failed    = entries.filter(e => e.consecutive_errors >= 3).length;
  const neverRun  = entries.filter(e => e.total_runs === 0).length;
  const lastRun   = entries.reduce((max, e) => {
    const t = e.last_success || e.last_error || '';
    return t > max ? t : max;
  }, '');

  return {
    total: entries.length,
    healthy,
    degraded,
    failed,
    never_run: neverRun,
    last_run: lastRun,
    connectors: Object.keys(status),
  };
}

// ── Cache de emergencia ────────────────────────────────────────────────
// Si api_cache.json falla (corrupto, no existe), servir api_cache.prev.json

function loadCacheSafe() {
  // Intentar cache principal
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (data.contratos && data.contratos.length > 0) {
        return { source: 'primary', data, stale: false };
      }
    }
  } catch (err) {
    console.error(`[health] Cache principal corrupto: ${err.message}`);
  }

  // Fallback a cache anterior
  try {
    if (fs.existsSync(CACHE_PREV)) {
      const data = JSON.parse(fs.readFileSync(CACHE_PREV, 'utf-8'));
      if (data.contratos && data.contratos.length > 0) {
        console.warn('[health] Sirviendo cache anterior (api_cache.prev.json)');
        return { source: 'previous', data, stale: true };
      }
    }
  } catch (err) {
    console.error(`[health] Cache anterior corrupto: ${err.message}`);
  }

  // Último recurso: cargar desde archivos JSON individuales
  console.warn('[health] Sin cache disponible, cargando desde fuentes originales');
  return { source: 'individual', data: null, stale: true };
}

function rotateCache() {
  // Antes de regenerar, guardar cache actual como previo
  try {
    if (fs.existsSync(CACHE_FILE)) {
      fs.copyFileSync(CACHE_FILE, CACHE_PREV);
    }
  } catch (_) {}
}

module.exports = {
  record,
  getStatus,
  getSummary,
  loadCacheSafe,
  rotateCache,
  HEALTH_FILE,
  CACHE_FILE,
  CACHE_PREV,
};