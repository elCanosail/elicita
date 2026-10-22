/**
 * connector-bootstrap.js — Bootstrap para ejecutar un conector en proceso hijo
 *
 * Carga el conector, ejecuta su función run(), y comunica el resultado
 * via process.send() de vuelta al scheduler.
 *
 * Uso: node connector-bootstrap.js <connector-name>
 */

const path = require('path');

const connectorName = process.argv[2];
if (!connectorName) {
  process.send?.({ type: 'result', data: { name: 'unknown', status: 'error', count: 0, duration_ms: 0, error: 'No connector name provided' } });
  process.exit(1);
}

async function run() {
  const start = Date.now();
  try {
    const connector = require(path.join(__dirname, 'connectors', connectorName));
    if (!connector || typeof connector.run !== 'function') {
      process.send?.({
        type: 'result',
        data: { name: connectorName, status: 'skip', count: 0, duration_ms: Date.now() - start }
      });
      process.exit(0);
    }

    const result = await connector.run();
    const duration_ms = Date.now() - start;
    const count = result?.total || 0;

    process.send?.({
      type: 'result',
      data: { name: connectorName, status: 'ok', count, duration_ms }
    });
    process.exit(0);
  } catch (err) {
    const duration_ms = Date.now() - start;
    process.send?.({
      type: 'result',
      data: { name: connectorName, status: 'error', count: 0, duration_ms, error: err.message }
    });
    process.exit(1);
  }
}

run();