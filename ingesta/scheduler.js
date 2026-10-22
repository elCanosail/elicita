/**
 * Scheduler de ingesta — Elicita v4
 * ═══════════════════════════════════════════════════════════════════
 *
 * v4: Cada conector se ejecuta en proceso hijo aislado.
 *     - PLACSP (188MB ZIP) tiene su propio heap de 2GB
 *     - Los conectores pequeños comparten heap de 512MB
 *     - Si un conector OOM, solo muere ese proceso, no el scheduler
 *     - Memoria total del scheduler: ~50MB (sin datos)
 *
 * Cron: cada 4 horas | PLACSP: diario 06:00 UTC
 */

const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { forkConnector } = require('./connector-runner');
const { runAlertas } = require('./alertas-runner');
const { runBatchResumen } = require('./lib/ai-resumen');

// ── Salvaguardas de proceso ────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
});

const LOG_FILE = path.join(__dirname, 'logs', 'scheduler.log');
const MAX_LOG_SIZE = 50 * 1024 * 1024; // Rotate at 50MB
const { record, getStatus, getSummary } = require('./lib/health');
const { generateCache } = require('./scripts/generate-cache');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (_) {}
      }
    } catch (_) {}
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

// ── Definición de conectores ───────────────────────────────────────────
const CONNECTORS = [
  { name: 'ted',          timeout: 120000 },
  { name: 'doga',         timeout: 420000 }, // PLACE Atom — servidor lento, 15 págs × ~30s
  { name: 'boe',          timeout: 300000 }, // 5 min — BOE HTML pesa, 120s insuficiente
  { name: 'galicia_v2',   timeout: 120000 },
  { name: 'madrid_ayto',  timeout: 120000 },
  { name: 'dogv',         timeout: 420000 }, // PLACE Atom — servidor lento, 15 págs × ~30s
  { name: 'asturias',     timeout: 180000 }, // CSV años recientes
  { name: 'andalucia_v2', timeout: 300000 }, // ES pagination 6 sorts × ~850 págs
  { name: 'catalunya',    timeout: 120000 },
  { name: 'euskadi_v2',   timeout: 900000 }, // 15 min — ~421MB download+parse (2026:204MB + 2025:217MB) + enriquecimiento XML; medido 271.8s y creciendo. Año cerrado cacheado reduce a ~205MB
  { name: 'madrid_cm',    timeout: 180000 },
  // PLACE eliminado: redundante con TED (ambos usan TED API para contratos españoles)
];

const PLACSP = { name: 'placsp', timeout: 600000 }; // 10 min — large ZIP download

// ── Truncar JSONs grandes antes de la ingesta ──────────────────────────
const DATA_DIR = path.join(__dirname, 'data');

const TRUNCATE_DAYS = {
  placsp: 30,
  // asturias: merge purges by estado (adjudicada/formalizada → 730d, activo → 180d)
  madrid_cm: 90,
};
const DEFAULT_TRUNCATE_DAYS = 90;
// euskadi: NO se trunca — el conector (skipPurge) y el backfill histórico mantienen
// el histórico completo de 2011+. Un TRIM previo aquí borraba los 354K del backfill.
const NO_TRUNCATE = new Set(['euskadi']);

function truncateJsonFile(filename) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < 5 * 1024 * 1024) return;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const contratos = data.contratos || [];
    if (contratos.length === 0) return;

    const connectorName = filename.replace('_contracts.json', '');
    if (NO_TRUNCATE.has(connectorName)) {
      log(`[TRIM] ${filename}: skip (histórico perpetuo — ${connectorName})`);
      return;
    }
    const days = TRUNCATE_DAYS[connectorName] || DEFAULT_TRUNCATE_DAYS;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const recent = contratos.filter(c => {
      const fp = String(c.fecha_publicacion || '');
      const match = fp.match(/^(\d{4}-\d{2}-\d{2})/);
      if (match) return match[1] >= cutoff;
      return true;
    });

    if (recent.length < contratos.length) {
      data.contratos = recent;
      data.total = recent.length;
      const tmpFile = filePath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data));
      fs.renameSync(tmpFile, filePath);
      const newSize = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
      log(`[TRIM] ${filename}: ${contratos.length} → ${recent.length} contracts | ${newSize}MB`);
    }
  } catch (e) {
    log(`[TRIM] Error truncating ${filename}: ${e.message}`);
  }
}

// ── Ejecutar conectores en procesos hijos aislados ──────────────────────
async function runAll() {
  log('═══ Ciclo de ingesta iniciado (forked) ═══');
  const cycleStart = Date.now();

  // Truncate large JSONs (euskadi excluido: histórico perpetuo)
  for (const name of ['placsp', 'madrid_cm']) {
    truncateJsonFile(`${name}_contracts.json`);
  }

  const resumen = {};
  for (const config of CONNECTORS) {
    const result = await forkConnector(config.name, { timeout: config.timeout });
    resumen[config.name] = result;

    const emoji = result.status === 'ok' ? '✅' : result.status === 'error' ? '❌' : '⏭';
    log(`[${config.name}] ${emoji} ${result.count || 0} contratos | ${result.status}${result.error ? ` (${result.error})` : ''} | ${(result.duration_ms / 1000).toFixed(1)}s`);
  }

  const results = Object.values(resumen);
  const ok = results.filter(r => r.status === 'ok').length;
  const errors = results.filter(r => r.status === 'error').length;
  const skipped = results.filter(r => r.status === 'skip').length;
  const totalContratos = results.reduce((s, r) => s + (r.count || 0), 0);
  const cycleDuration = Date.now() - cycleStart;

  log(`═══ Ciclo completado en ${(cycleDuration / 1000).toFixed(1)}s | ✅ ${ok} ok | ❌ ${errors} errors | ⏭ ${skipped} skip | 📊 ${totalContratos} contratos ═══`);

  // Record health
  for (const [name, result] of Object.entries(resumen)) {
    record(name, result);
  }

  const health = getSummary();
  log(`Health: ${health.healthy} ok, ${health.degraded} degraded, ${health.failed} failed`);

  fs.writeFileSync(
    path.join(__dirname, 'data', 'status.json'),
    JSON.stringify({
      ultima_ejecucion: new Date().toISOString(),
      cycle_duration_ms: cycleDuration,
      connectors_ok: ok,
      connectors_error: errors,
      connectors_skip: skipped,
      total_contratos: totalContratos,
      health,
      resultados: Object.fromEntries(
        Object.entries(resumen).map(([k, v]) => [k, v.count || 0])
      ),
    }, null, 2)
  );

  // Generate api_cache.json for health endpoint
  try {
    generateCache();
  } catch (cacheErr) {
    log(`[CACHE] Error generating cache: ${cacheErr.message}`);
  }

  // Materializar los JSON recién ingeridos en una candidata, validarla y
  // promoverla atómicamente. El script conserva el histórico de cada fuente.
  try {
    const materializeScript = path.join(__dirname, 'scripts', 'materialize-duckdb.sh');
    const output = execFileSync(materializeScript, [], {
      timeout: 20 * 60 * 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lastLine = output.trim().split('\n').at(-1) || 'completada';
    log(`[MATERIALIZE] ${lastLine}`);
  } catch (materializeErr) {
    const detail = materializeErr.stderr?.trim() || materializeErr.message;
    log(`[MATERIALIZE] Error: ${detail}`);
  }

  // Generar resúmenes IA para contratos nuevos (máx 500 por ciclo)
  try {
    const resumenStats = await runBatchResumen(500);
    log(`[IA-RESUMEN] ${resumenStats.generados} generados, ${resumenStats.errores} errores`);
  } catch (resumenErr) {
    log(`[IA-RESUMEN] Error en batch: ${resumenErr.message}`);
  }

  // Extraer pliegos PDF para contratos nuevos (máx 20 por ciclo)
  try {
    const pliegoScript = path.join(__dirname, '..', 'scripts', 'pliego-parser', 'extract_pliego_v3.py');
    const output = execFileSync('python3', [pliegoScript, '20'], {
      timeout: 600000, // 10 min max
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Parse last line for stats
    const lines = output.trim().split('\n');
    const lastLine = lines[lines.length - 1] || '';
    log(`[PLIEGOS] ${lastLine.replace(/^\[\d+:\d+:\d+\] /, '')}`);
  } catch (pliegoErr) {
    log(`[PLIEGOS] Error: ${pliegoErr.message}`);
  }

  // After ingestion, run matching for active profiles
  try {
    const { runMatching } = require('./matching-runner.js');
    const matchStats = await runMatching();
    log(`[MATCHING] ${matchStats.usuarios_procesados} usuarios, ${matchStats.contratos_matcheados} matches, ${matchStats.emails_enviados} emails`);
  } catch (e) {
    log(`[scheduler] Error en matching: ${e.message}`);
  }
}

async function runPLACSP() {
  log('--- PLACSP diario iniciado (forked) ---');
  const result = await forkConnector('placsp', { timeout: PLACSP.timeout });
  record('placsp', result);
  const emoji = result.status === 'ok' ? '✅' : '❌';
  log(`--- PLACSP ${emoji} ${result.count || 0} contratos | ${result.status} | ${(result.duration_ms / 1000).toFixed(1)}s ---`);
}

// ── Inicio ──────────────────────────────────────────────────────────────
const fuentes = CONNECTORS.map(c => c.name.toUpperCase()).join(', ');
log(`Scheduler Elicita v4 (forked) activo — ciclo cada 4h | Fuentes: ${fuentes}`);
log(`PLACSP — diario a las 06:00 UTC (proceso aislado, heap 2GB)`);

runAll();
runPLACSP();

cron.schedule('0 */4 * * *', () => {
  log('Cron trigger — iniciando ciclo');
  runAll();
});

cron.schedule('0 6 * * *', () => {
  log('Cron trigger PLACSP — ejecución diaria');
  runPLACSP();
});

cron.schedule('30 */4 * * *', () => {
  log('Cron trigger — alertas');
  runAlertas()
    .then((res) => {
      log(`[ALERTAS] ${res.sent} enviados, ${res.skipped} saltados, ${res.errors} errores`);
    })
    .catch((e) => {
      log(`[ALERTAS] Error: ${e.message}`);
    });
});

// Reporte semanal: lunes 08:00 UTC
const { runReporteSemanal } = require('./reporte-semanal');
cron.schedule('0 8 * * 1', () => {
  log('Cron trigger — reporte semanal');
  runReporteSemanal()
    .then((res) => {
      log(`[REPORTE] Enviados ${res.enviados}, errores ${res.errores}`);
    })
    .catch((e) => {
      log(`[REPORTE] Error: ${e.message}`);
    });
});