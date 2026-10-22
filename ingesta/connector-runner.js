/**
 * connector-runner.js — Ejecuta un conector en proceso hijo aislado
 *
 * v4: Cada conector corre en su propio proceso con heap aislado.
 *     - Si un conector OOM, solo muere ese proceso, no el scheduler.
 *     - Memoria del scheduler: ~70MB (sin datos).
 *     - PLACSP: 4GB heap (188MB ZIP → xml2js necesita ~3.5GB)
 */

const path = require('path');
const child_process = require('child_process');

const CONNECTOR_DIR = path.join(__dirname, 'connectors');

// Memory limits per connector (MB) — isolated process heap
const MEMORY_LIMITS = {
  placsp: 6144,      // Downloads 188MB ZIP, xml2js needs ~4.3GB peak
  place: 512,        // Paginated ATOM, moderate
  ted: 512,          // ATOM feeds
  galicia_v2: 512,   // API paginada
  euskadi_v2: 4096,  // Downloads 130+220MB JSON, JSON.parse needs ~1.5GB peak
  catalunya: 512,    // API
  andalucia_v2: 512, // API
  madrid_cm: 512,    // HTML parsing
  madrid_ayto: 512,  // HTML parsing
  asturias: 1024,     // Large JSON (133MB) — needs heap for merge
  doga: 1024,         // PLACE Atom paginado, acumula XML de ~10 páginas
  dogv: 1024,         // PLACE Atom paginado, acumula ~10 páginas de XML
  boe: 256,          // Small ATOM
};

const DEFAULT_MEMORY = 512;

/**
 * Ejecuta un conector en un proceso hijo aislado con su propio heap.
 * @param {string} name - Nombre del conector (sin extensión)
 * @param {object} opts - Opciones: timeout (ms), maxMemory (MB override)
 * @returns {Promise<{name, status, count, duration_ms, error?}>}
 */
function forkConnector(name, opts = {}) {
  return new Promise((resolve) => {
    const { timeout = 180000, maxMemory } = opts;
    const memMB = maxMemory || MEMORY_LIMITS[name] || DEFAULT_MEMORY;
    const start = Date.now();

    const child = child_process.fork(
      path.join(__dirname, 'connector-bootstrap.js'),
      [name],
      {
        execArgv: [
          `--max-old-space-size=${memMB}`,
          '--expose-gc',
        ],
        cwd: __dirname,
        env: { ...process.env, NODE_OPTIONS: '' },
        timeout: timeout + 30000, // Kill if process hangs
      }
    );

    let result = null;
    let timedOut = false;
    let oomDetected = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }, 5000);
    }, timeout);

    // Detect OOM from child stderr
    child.stderr?.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('out of memory') || msg.includes('heap limit')) {
        oomDetected = true;
      }
    });

    child.on('message', (msg) => {
      if (msg.type === 'result') {
        result = msg.data;
      }
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - start;

      if (timedOut) {
        resolve({ name, status: 'error', count: 0, duration_ms, error: `timeout ${timeout}ms` });
      } else if (oomDetected) {
        resolve({ name, status: 'error', count: 0, duration_ms, error: `OOM (heap limit ${memMB}MB exceeded)` });
      } else if (code !== 0 && !result) {
        const sig = signal ? `signal ${signal}` : `code ${code}`;
        resolve({ name, status: 'error', count: 0, duration_ms, error: `process exited with ${sig}` });
      } else {
        resolve(result || { name, status: 'skip', count: 0, duration_ms });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - start;
      resolve({ name, status: 'error', count: 0, duration_ms, error: err.message });
    });
  });
}

module.exports = { forkConnector, MEMORY_LIMITS };