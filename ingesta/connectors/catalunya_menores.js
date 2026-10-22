/**
 * Conector Catalunya Menores — Contratos menores Generalitat (Socrata API)
 *
 * Fuente:    Transparència Catalunya (Open Data)
 * Dataset:   qjue-2pk9 — Contractació menor de la Generalitat
 * Endpoint:  https://analisi.transparenciacatalunya.cat/resource/qjue-2pk9.json
 * Registros: ~866K (actualizado periódicamente)
 *
 * Estrategia:
 *   - El script Python (scripts/fetch_catalunya_menores.py) hace el fetch pesado
 *   - Este conector solo orquesta: llama al script, gestiona logs, reporta stats
 *   - El output va directamente a /var/data/licitaciones/data/catalunya/contratacion/
 *   - El load.py de DuckDB lo incorpora automáticamente en la tabla "catalunya"
 *
 * Campos Socrata → Canonical Elicita:
 *   any                        → Any
 *   codi_d_expedient           → Codi d'expedient
 *   departament_d_adscripci    → Departament d'adscripció
 *   rgan_de_contractaci        → Òrgan de contractació
 *   mbit_subjectiu             → Àmbit subjectiu
 *   tipus_de_contracte         → Tipus de contracte
 *   procediment_d_adjudicaci   → Procediment d'adjudicació
 *   objecte_del_contracte      → Descripció del contracte
 *   import_adjudicat_sense_iva → Import adjudicat sense IVA
 *   empresa_adjudicat_ria      → Empresa adjudicatària
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'fetch_catalunya_menores.py');
const PARQUET_FILE = path.join('/var/data/licitaciones/data/catalunya/contratacion', 'contratos_menores_generalitat.parquet');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'catalunya_menores.log');

const BATCH_SIZE = 50000;
const MAX_RUNTIME_MIN = 30;  // Si tarda más, se reanudará en el siguiente ciclo

function log(msg) {
  const line = `[${new Date().toISOString()}] [catalunya_menores] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function getParquetCount() {
  try {
    if (!fs.existsSync(PARQUET_FILE)) return 0;
    const out = execSync(
      `python3 -c "import pandas as pd; print(len(pd.read_parquet('${PARQUET_FILE}')))"`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    return parseInt(out.trim(), 10) || 0;
  } catch (e) {
    return 0;
  }
}

async function run() {
  log('Iniciando ingesta Catalunya Menores (Socrata API)...');

  const existingCount = getParquetCount();
  log(`Registros existentes: ${existingCount.toLocaleString()}`);

  // Decidir si es full o incremental
  const isResume = existingCount > 0;
  const resumeFlag = isResume ? '--resume' : '';

  try {
    const cmd = `python3 "${SCRIPT}" ${resumeFlag} --batch-size ${BATCH_SIZE}`;
    log(`Ejecutando: ${cmd}`);

    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: MAX_RUNTIME_MIN * 60 * 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    log(output.trim().split('\n').slice(-5).join('\n'));  // últimas 5 líneas

    const finalCount = getParquetCount();
    const delta = finalCount - existingCount;
    log(`Completado: ${finalCount.toLocaleString()} total (${delta >= 0 ? '+' : ''}${delta.toLocaleString()} nuevos)`);

    return { total: finalCount, delta };
  } catch (err) {
    log(`ERROR: ${err.message}`);
    // Si falló por timeout, el checkpoint permite reanudar
    if (err.message.includes('ETIMEDOUT') || err.status === null) {
      log('Timeout alcanzado — se reanudará en el siguiente ciclo');
    }
    return { total: existingCount, delta: 0, error: err.message };
  }
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(r => console.log(`Total Catalunya Menores: ${r.total} (${r.delta || 0} nuevos)`))
    .catch(err => console.error('ERROR:', err.message));
}
