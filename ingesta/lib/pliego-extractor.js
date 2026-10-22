/**
 * Pliego extractor — integra pdf-inspector en el pipeline de ingesta.
 * 
 * Flujo: 
 * 1. SELECT licitaciones con URL de pliego, sin pliego extraído
 * 2. Descargar PDF (agent-browser + curl)
 * 3. pdf-inspector → markdown (Rust, ~3ms)
 * 4. DeepSeek V4 Flash → campos estructurados (JSON)
 * 5. INSERT en pliegos_extraidos
 * 
 * Fallback LLM: DeepSeek NaN → Gemma4 NaN → Gemma4 Ollama → skip
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
const WORK_DIR = '/tmp/pliegos_ingesta';
const NAN_API = 'https://api.nan.builders/v1/chat/completions';
const NAN_KEY = fs.readFileSync('/root/.nan_api_key', 'utf8').trim();
const OLLAMA_API = process.env.OLLAMA_BASE_URL || 'https://ollama.com/v1/chat/completions';
const OLLAMA_KEY = process.env.OLLAMA_API_KEY || '';

const PRIMARY_MODEL = 'deepseek-v4-flash';
const NAN_FALLBACK_MODEL = 'gemma4';
const OLLAMA_FALLBACK_MODEL = 'gemma4:31b';

const MAX_PLIEGOS_PER_CYCLE = 20;
const PDF_DOWNLOAD_TIMEOUT = 30;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [pliegos] ${msg}`);
}

function getReadConn() {
  const duckdb = require('duckdb');
  const WEB_STATE_PATH = process.env.DUCKDB_WEB_STATE_PATH || '/var/data/licitaciones/db/web-state.duckdb';
  // READ-ONLY: la base de ingesta nunca se abre en RW fuera del materializador.
  const db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
  db.exec("SET memory_limit = '2GB'; SET threads = 2; SET preserve_insertion_order = false;");
  const conn = db.connect();
  conn.exec("SET memory_limit = '2GB'; SET threads = 2; SET preserve_insertion_order = false;");
  // web-state attachado en RO para el JOIN de pendientes
  for (let i = 1; ; i++) {
    try {
      conn.run(`ATTACH '${WEB_STATE_PATH}' AS ws (READ_ONLY)`);
      break;
    } catch (e) {
      if (i >= 8 || !/Could not set lock|Conflicting lock/i.test(String(e?.message))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    }
  }
  return conn;
}

/** Escritura puntual en web-state: abrir → run → cerrar, con reintentos. */
function dbRunState(sql, ...params) {
  const duckdb = require('duckdb');
  const WEB_STATE_PATH = process.env.DUCKDB_WEB_STATE_PATH || '/var/data/licitaciones/db/web-state.duckdb';
  return (async () => {
    for (let attempt = 1; ; attempt++) {
      let sdb = null, sconn = null;
      try {
        sdb = new duckdb.Database(WEB_STATE_PATH);
        sconn = sdb.connect();
        await new Promise((resolve, reject) => {
          sconn.run(sql, ...params, (err) => (err ? reject(err) : resolve()));
        });
        return;
      } catch (e) {
        if (attempt < 6 && /Could not set lock|Conflicting lock/i.test(String(e?.message))) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
          continue;
        }
        throw e;
      } finally {
        try { sconn && sconn.close(); } catch (_) {}
        try { sdb && sdb.close(); } catch (_) {}
      }
    }
  })();
}

function dbAll(conn, sql, ...params) {
  return new Promise((resolve, reject) => {
    conn.all(sql, ...params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbRun(conn, sql, ...params) {
  return new Promise((resolve, reject) => {
    conn.run(sql, ...params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Download pliego PDF using agent-browser to find URL, then curl to download.
 */
async function downloadPliegoPDF(licitacionUrl, id) {
  const safeId = id.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50);
  const pdfPath = path.join(WORK_DIR, `pliego_${safeId}.pdf`);

  if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 5000) {
    return pdfPath;
  }

  try {
    execSync(`npx agent-browser open "${licitacionUrl}"`, {
      timeout: 20000, stdio: 'pipe'
    });
    await new Promise(r => setTimeout(r, 5000));

    const js = `(function(){
      var rows = Array.from(document.querySelectorAll("tr"));
      var r = rows.find(function(x){
        return Array.from(x.querySelectorAll("td")).some(function(c){
          return c.textContent.trim() === "Pliego";
        });
      });
      if(!r) return JSON.stringify({found:false});
      var ls = Array.from(r.querySelectorAll("a")).map(function(a){
        var img = a.querySelector("img");
        return {href: a.href, alt: img ? img.alt : ""};
      });
      return JSON.stringify({found:true, links: ls});
    })()`;

    const result = execSync(`npx agent-browser eval '${js.replace(/'/g, "'\\''")}'`, {
      timeout: 15000, stdio: 'pipe', encoding: 'utf8'
    });

    let data;
    try { data = JSON.parse(result.trim()); } catch { return null; }
    if (!data.found) return null;

    let pdfUrl = null;
    for (const link of data.links) {
      if (link.alt === 'Documento pdf' && link.href.includes('GetDocumentByIdServlet')) {
        pdfUrl = link.href;
        break;
      }
    }
    if (!pdfUrl) {
      for (const link of data.links) {
        if (link.href.includes('GetDocumentByIdServlet')) { pdfUrl = link.href; break; }
      }
    }
    if (!pdfUrl) return null;

    execSync(
      `curl -s -L -o "${pdfPath}" ` +
      `-H "User-Agent: Mozilla/5.0 (X11; Linux x86_64)" ` +
      `-H "Referer: https://contrataciondelestado.es/" ` +
      `--max-time ${PDF_DOWNLOAD_TIMEOUT} "${pdfUrl}"`,
      { timeout: (PDF_DOWNLOAD_TIMEOUT + 5) * 1000, stdio: 'pipe' }
    );

    if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 5000) {
      return pdfPath;
    }
    return null;
  } catch (e) {
    log(`  Error downloading PDF for ${id}: ${e.message}`);
    return null;
  }
}

/**
 * Extract markdown from PDF using pdf-inspector (Python).
 */
async function extractPDF(pdfPath) {
  try {
    const result = execSync(
      `python3 -c "
import pdf_inspector, json, time
t0 = time.time()
r = pdf_inspector.process_pdf('${pdfPath.replace(/'/g, "'\\''")}')
t1 = time.time()
print(json.dumps({'pdf_type': r.pdf_type, 'markdown': r.markdown or '', 'time_ms': int((t1-t0)*1000)}))
"`,
      { timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(result.trim());
  } catch (e) {
    log(`  pdf-inspector error: ${e.message}`);
    return null;
  }
}

/**
 * Extract structured fields from markdown using LLM.
 * Fallback: DeepSeek NaN → Gemma4 NaN → Gemma4 Ollama
 */
async function extractFields(markdown) {
  const prompt = `Analiza este pliego de contratación pública española. Extrae SOLO JSON válido:
{
  "criterios_adjudicacion": [{"nombre": "...", "peso_pct": 0, "subtipo": "formula/juicio"}],
  "solvencia_economica": "...",
  "solvencia_tecnica": "...",
  "plazo_ejecucion": "...",
  "garantia_definitiva": "...",
  "procedimiento": "...",
  "plazo_presentacion": "...",
  "notas": "..."
}

TEXTO:
${markdown.slice(0, 5000)}`;

  const models = [
    { api: NAN_API, key: NAN_KEY, model: PRIMARY_MODEL, name: 'deepseek-v4-flash' },
    { api: NAN_API, key: NAN_KEY, model: NAN_FALLBACK_MODEL, name: 'gemma4-nan' },
    { api: OLLAMA_API, key: OLLAMA_KEY, model: OLLAMA_FALLBACK_MODEL, name: 'gemma4-ollama' },
  ];

  for (const m of models) {
    if (!m.key) continue;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const resp = await fetch(m.api, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${m.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: m.model,
          max_tokens: 1024,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        log(`  LLM ${m.name} HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log(`  LLM ${m.name} no JSON found`);
        continue;
      }

      const fields = JSON.parse(jsonMatch[0]);
      return { fields, model: m.name, tokens: data.usage?.total_tokens || 0 };
    } catch (e) {
      log(`  LLM ${m.name} error: ${e.message}`);
      continue;
    }
  }

  return { fields: null, model: 'none', tokens: 0 };
}

/**
 * Main: run pliego extraction batch.
 */
async function runPliegoBatch(limit = MAX_PLIEGOS_PER_CYCLE) {
  log(`Iniciando batch de extracción de pliegos (máx ${limit})...`);

  fs.mkdirSync(WORK_DIR, { recursive: true });

  const conn = getReadConn();

  // Tabla pliegos_extraidos vive en web-state (crear si falta)
  const createSQL = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'create-pliegos-table.sql'),
    'utf8'
  );
  await dbRunState(createSQL).catch(() => {}); // Ignore if already exists

  // Get pending pliegos
  const pending = await dbAll(conn, `
    SELECT v.id, v.expediente, v.objeto, v.organo_contratante, v.importe_licitacion, v.url
    FROM (
      SELECT id, expediente, objeto, organo_contratante, importe_licitacion, url
      FROM nacional
      WHERE url LIKE '%contrataciondelestado.es%'
        AND url NOT LIKE '%sindicacion%'
        AND importe_licitacion > 50000
      UNION ALL
      SELECT id, expediente, objeto, organo_contratante, importe_licitacion, url
      FROM ted
      WHERE url LIKE '%contrataciondelestado.es%'
        AND url NOT LIKE '%sindicacion%'
        AND importe_licitacion > 50000
    ) v
    LEFT JOIN ws.pliegos_extraidos p ON p.id_contrato = v.id
    WHERE p.id_contrato IS NULL
      AND v.url IS NOT NULL
    ORDER BY v.importe_licitacion DESC
    LIMIT ?
  `, limit);

  if (pending.length === 0) {
    log('No hay pliegos pendientes.');
    conn.close();
    return { procesados: 0, extraidos: 0, errores: 0, skipped: 0 };
  }

  log(`${pending.length} pliegos pendientes.`);

  let extraidos = 0, errores = 0, skipped = 0;

  for (const exp of pending) {
    log(`[${extraidos + errores + skipped + 1}/${pending.length}] ${exp.expediente} | ${String(exp.objeto).slice(0, 55)} | ${(exp.importe_licitacion / 1000).toFixed(0)}K€`);

    // 1. Download PDF
    const pdfPath = await downloadPliegoPDF(exp.url, exp.id);
    if (!pdfPath) {
      log('  ✗ Sin PDF de pliego — skip');
      await dbRunState(`
        INSERT OR REPLACE INTO pliegos_extraidos
        (id_contrato, url_pdf, pdf_type, markdown, campos_json, modelo_ocr, modelo_llm, tiempo_extraccion_ms, fecha_extraccion)
        VALUES (?, '', 'not_found', '', '{"error": "no_pliego_pdf"}', 'none', 'none', 0, NOW())
      `, exp.id).catch(() => {});
      skipped++;
      continue;
    }

    const kb = Math.round(fs.statSync(pdfPath).size / 1024);
    log(`  ✓ PDF ${kb}KB`);

    // 2. Extract with pdf-inspector
    const extracted = await extractPDF(pdfPath);
    if (!extracted || !extracted.markdown) {
      log('  ✗ pdf-inspector sin contenido');
      await dbRunState(`
        INSERT OR REPLACE INTO pliegos_extraidos
        (id_contrato, url_pdf, pdf_type, markdown, campos_json, modelo_ocr, modelo_llm, tiempo_extraccion_ms, fecha_extraccion)
        VALUES (?, '', ?, '', '{"error": "extraction_failed"}', 'pdf-inspector', 'none', ?, NOW())
      `, exp.id, extracted?.pdf_type || 'error', extracted?.time_ms || 0).catch(() => {});
      errores++;
      try { fs.unlinkSync(pdfPath); } catch {}
      continue;
    }

    log(`  ✓ ${extracted.pdf_type} | ${extracted.time_ms}ms | ${extracted.markdown.length} chars`);

    // 3. Extract fields with LLM
    const { fields, model: llmModel, tokens } = await extractFields(extracted.markdown);

    if (fields && fields.criterios_adjudicacion) {
      log(`  ✓ ${llmModel} | ${fields.criterios_adjudicacion.length} criterios | ${tokens} tokens`);
    } else {
      log(`  ⚠ ${llmModel} — extracción parcial`);
    }

    // 4. Save to DB
    await dbRunState(`
      INSERT OR REPLACE INTO pliegos_extraidos
      (id_contrato, url_pdf, pdf_type, markdown, campos_json, modelo_ocr, modelo_llm, tiempo_extraccion_ms, fecha_extraccion)
      VALUES (?, ?, ?, ?, ?, 'pdf-inspector', ?, ?, NOW())
    `, exp.id, exp.url, extracted.pdf_type, extracted.markdown,
      JSON.stringify(fields || { error: 'llm_failed' }),
      llmModel, extracted.time_ms
    ).catch(e => log(`  DB error: ${e.message}`));
    extraidos++;

    // Clean up PDF
    try { fs.unlinkSync(pdfPath); } catch {}

    // Delay between requests
    await new Promise(r => setTimeout(r, 500));
  }

  log(`Batch completo: ${extraidos} extraídos, ${errores} errores, ${skipped} sin PDF`);
  conn.close();
  return { procesados: pending.length, extraidos, errores, skipped };
}

module.exports = { runPliegoBatch };