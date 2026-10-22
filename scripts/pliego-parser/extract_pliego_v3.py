#!/usr/bin/env python3
"""
Pliego extractor v3 — standalone para ejecutar desde el scheduler.
Usa pdf-inspector + DeepSeek V4 Flash para extraer campos de pliegos PDF.

Uso: python3 extract_pliego_v3.py [limit]

Flujo:
1. Conectar a DuckDB (copia temporal si hay lock)
2. SELECT licitaciones sin pliego extraído
3. Descargar PDF (agent-browser + curl)
4. pdf-inspector → markdown (~3ms)
5. DeepSeek V4 Flash → campos JSON (~16s)
6. INSERT en pliegos_extraidos
"""
import sys, json, time, subprocess, os, re, requests
from pathlib import Path

import pdf_inspector

DB_PATH = '/var/data/licitaciones/db/licitaciones.duckdb'
WORK_DIR = Path('/tmp/pliegos_ingesta')
WORK_DIR.mkdir(exist_ok=True)

NAN_API = 'https://api.nan.builders/v1/chat/completions'
NAN_KEY = Path('/root/.nan_api_key').read_text().strip()
NAN_MODEL = 'deepseek-v4-flash'
NAN_FALLBACK_MODEL = 'gemma4'

OLLAMA_API = 'https://ollama.com/v1/chat/completions'
OLLAMA_KEY = os.environ.get('OLLAMA_API_KEY', '')
OLLAMA_MODEL = 'gemma4:31b'


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def get_conn():
    """Connect to a copy of DuckDB in read-only mode (MCP server holds write lock)"""
    import duckdb, shutil, tempfile
    # Copy DB to temp file to avoid lock conflicts
    tmp_path = '/tmp/licitaciones_ro.duckdb'
    try:
        shutil.copy2(DB_PATH, tmp_path)
        con = duckdb.connect(tmp_path, read_only=True)
        return con
    except Exception as e:
        log(f"DB copy error: {e}")
        raise


def get_write_conn():
    """Connect to DuckDB for writing — retry until MCP releases lock"""
    import duckdb
    for attempt in range(5):
        try:
            con = duckdb.connect(DB_PATH)
            return con
        except Exception as e:
            if 'Conflicting lock' in str(e) and attempt < 4:
                log(f'  DB locked, retry {attempt+1}/5...')
                time.sleep(3)
            else:
                raise


def ensure_table(con):
    """Create pliegos_extraidos if not exists"""
    sql = Path('/root/.openclaw/workspace/projects/elicita/scripts/create-pliegos-table.sql').read_text()
    con.execute(sql)


def get_pending(con, limit=20):
    """Get licitaciones without pliego extracted"""
    # Load already extracted IDs from JSON
    already_extracted = set()
    json_file = Path('/root/.openclaw/workspace/projects/elicita/ingesta/data/pliegos_extraidos.json')
    if json_file.exists():
        try:
            for p in json.loads(json_file.read_text()):
                already_extracted.add(p['id_contrato'])
        except:
            pass

    rows = con.execute("""
        SELECT v.id, v.expediente, v.objeto, v.organo, v.importe, v.url
        FROM (
            SELECT id, expediente, objeto, organo_contratante AS organo, importe_sin_iva AS importe, url
            FROM nacional
            WHERE url LIKE '%contrataciondelestado.es%'
              AND url NOT LIKE '%sindicacion%'
              AND importe_sin_iva > 50000
            UNION ALL
            SELECT id, expediente, objeto, organismo AS organo, importe_licitacion AS importe, url
            FROM ted_json
            WHERE url LIKE '%contrataciondelestado.es%'
              AND url NOT LIKE '%sindicacion%'
              AND importe_licitacion > 50000
        ) v
        WHERE v.url IS NOT NULL
        ORDER BY v.importe DESC
        LIMIT ?
    """, [limit * 3]).fetchall()  # Over-fetch to filter already extracted

    result = []
    for r in rows:
        if r[0] not in already_extracted:
            result.append({'id': r[0], 'expediente': r[1], 'objeto': str(r[2])[:100],
                          'organo': r[3], 'importe': r[4], 'url': r[5]})
            if len(result) >= limit:
                break
    return result


def download_pdf(licitacion_url, id_contrato):
    """Download pliego PDF using Playwright (headless Chromium)"""
    from playwright.sync_api import sync_playwright
    
    safe_id = re.sub(r'[^a-zA-Z0-9]', '_', id_contrato)[:50]
    pdf_path = WORK_DIR / f"pliego_{safe_id}.pdf"

    if pdf_path.exists() and pdf_path.stat().st_size > 5000:
        return str(pdf_path)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            )
            page = context.new_page()
            
            # Navigate to the licitation page
            # Use 'domcontentloaded' + explicit wait for table instead of networkidle
            page.goto(licitacion_url, wait_until='domcontentloaded', timeout=60000)
            
            # Wait for the document table to load (the page loads docs via AJAX)
            try:
                page.wait_for_selector('table tr', timeout=20000)
            except:
                # Try waiting a bit more and check if page has content
                page.wait_for_timeout(5000)
                if not page.query_selector('tr'):
                    log("  Page loaded but no table rows found")
                    browser.close()
                    return None
            
            # Find the Pliego PDF link
            js = '''() => {
                const rows = Array.from(document.querySelectorAll("tr"));
                const r = rows.find(x =>
                    Array.from(x.querySelectorAll("td")).some(c => c.textContent.trim() === "Pliego")
                );
                if (!r) return {found: false};
                const ls = Array.from(r.querySelectorAll("a")).map(a => {
                    const img = a.querySelector("img");
                    return {href: a.href, alt: img ? img.alt : ""};
                });
                return {found: true, links: ls};
            }'''
            
            data = page.evaluate(js)
            
            if not data or not data.get('found'):
                log("  No Pliego row found")
                browser.close()
                return None
            
            # Find PDF URL
            pdf_url = None
            for link in data.get('links', []):
                if link.get('alt') == 'Documento pdf' and 'GetDocumentByIdServlet' in link.get('href', ''):
                    pdf_url = link['href']
                    break
            if not pdf_url:
                for link in data.get('links', []):
                    if 'GetDocumentByIdServlet' in link.get('href', ''):
                        pdf_url = link['href']
                        break
            
            if not pdf_url:
                log("  No PDF link found in Pliego row")
                browser.close()
                return None
            
            # Download PDF via curl (faster than browser download)
            browser.close()
            
            subprocess.run([
                'curl', '-s', '-L', '-o', str(pdf_path),
                '-H', 'User-Agent: Mozilla/5.0 (X11; Linux x86_64)',
                '-H', 'Referer: https://contrataciondelestado.es/',
                '--max-time', '30', pdf_url
            ], capture_output=True, timeout=35)
            
            if pdf_path.exists() and pdf_path.stat().st_size > 5000:
                return str(pdf_path)
            return None
            
    except Exception as e:
        log(f"  Error downloading: {e}")
        return None


def extract_pdf(pdf_path):
    """Extract markdown with pdf-inspector"""
    try:
        t0 = time.time()
        result = pdf_inspector.process_pdf(pdf_path)
        t1 = time.time()
        return {
            'pdf_type': result.pdf_type,
            'markdown': result.markdown or '',
            'time_ms': int((t1 - t0) * 1000),
        }
    except Exception as e:
        log(f"  pdf-inspector error: {e}")
        return None


def extract_fields_llm(markdown):
    """Extract fields with LLM — DeepSeek → Gemma4 NaN → Gemma4 Ollama"""
    prompt = f"""Analiza este pliego de contratación pública española. Extrae SOLO JSON válido:
{{
  "criterios_adjudicacion": [{{"nombre": "...", "peso_pct": 0, "subtipo": "formula/juicio"}}],
  "solvencia_economica": "...",
  "solvencia_tecnica": "...",
  "plazo_ejecucion": "...",
  "garantia_definitiva": "...",
  "procedimiento": "...",
  "plazo_presentacion": "...",
  "notas": "..."
}}

TEXTO:
{markdown[:5000]}"""

    models = [
        (NAN_API, NAN_KEY, NAN_MODEL, 'deepseek-v4-flash'),
        (NAN_API, NAN_KEY, NAN_FALLBACK_MODEL, 'gemma4-nan'),
        (OLLAMA_API, OLLAMA_KEY, OLLAMA_MODEL, 'gemma4-ollama'),
    ]

    for api, key, model, name in models:
        if not key:
            continue
        try:
            resp = requests.post(api, timeout=30, headers={
                'Authorization': f'Bearer {key}',
                'Content-Type': 'application/json',
            }, json={
                'model': model,
                'max_tokens': 1024,
                'temperature': 0.1,
                'messages': [{'role': 'user', 'content': prompt}],
            })
            if resp.status_code != 200:
                log(f"  LLM {name} HTTP {resp.status_code}")
                continue
            data = resp.json()
            content = data['choices'][0]['message']['content']
            m = re.search(r'\{.*\}', content, re.DOTALL)
            if not m:
                log(f"  LLM {name} no JSON")
                continue
            fields = json.loads(m.group())
            return fields, name, data.get('usage', {}).get('total_tokens', 0)
        except Exception as e:
            log(f"  LLM {name} error: {e}")
            continue

    return None, 'none', 0


def save(con, id_contrato, url, pdf_type, markdown, campos, ocr_engine, llm_model, time_ms):
    """Save to DuckDB"""
    con.execute("""
        INSERT OR REPLACE INTO pliegos_extraidos
        (id_contrato, url_pdf, pdf_type, markdown, campos_json, modelo_ocr, modelo_llm, tiempo_extraccion_ms, fecha_extraccion)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
    """, [id_contrato, url or '', pdf_type, markdown,
          json.dumps(campos, ensure_ascii=False) if campos else '{}',
          ocr_engine, llm_model, time_ms])


def save_to_json(id_contrato, url, pdf_type, markdown, campos, ocr_engine, llm_model, time_ms):
    """Save to JSON file for batch loading into DuckDB later"""
    output_file = Path('/root/.openclaw/workspace/projects/elicita/ingesta/data/pliegos_extraidos.json')
    output_file.parent.mkdir(exist_ok=True)

    # Load existing
    existing = {}
    if output_file.exists():
        try:
            existing = {p['id_contrato']: p for p in json.loads(output_file.read_text())}
        except:
            pass

    existing[id_contrato] = {
        'id_contrato': id_contrato,
        'url_pdf': url or '',
        'pdf_type': pdf_type,
        'markdown': markdown,
        'campos_json': json.dumps(campos, ensure_ascii=False) if campos else '{}',
        'modelo_ocr': ocr_engine,
        'modelo_llm': llm_model,
        'tiempo_extraccion_ms': time_ms,
        'fecha_extraccion': time.strftime('%Y-%m-%d %H:%M:%S'),
    }

    output_file.write_text(json.dumps(list(existing.values()), ensure_ascii=False, indent=2))


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    log(f"Batch de pliegos (máx {limit})...")

    # Read conn (read-only)
    read_con = get_conn()

    pending = get_pending(read_con, limit)
    if not pending:
        log("No hay pliegos pendientes.")
        read_con.close()
        return

    log(f"{len(pending)} pliegos pendientes.")

    extraidos, errores, skipped = 0, 0, 0

    for i, exp in enumerate(pending):
        log(f"[{i+1}/{len(pending)}] {exp['expediente']} | {exp['objeto'][:55]} | {exp['importe']/1000:.0f}K€")

        # 1. Download PDF
        pdf_path = download_pdf(exp['url'], exp['id'])
        if not pdf_path:
            log("  ✗ Sin PDF — skip")
            save_to_json(exp['id'], '', 'not_found', '', {'error': 'no_pliego_pdf'}, 'none', 'none', 0)
            skipped += 1
            continue

        kb = Path(pdf_path).stat().st_size // 1024
        log(f"  ✓ PDF {kb}KB")

        # 2. Extract
        extracted = extract_pdf(pdf_path)
        if not extracted or not extracted['markdown']:
            log("  ✗ Sin contenido")
            save_to_json(exp['id'], exp['url'], extracted.get('pdf_type', 'error') if extracted else 'error',
                         '', {'error': 'extraction_failed'}, 'pdf-inspector', 'none',
                         extracted.get('time_ms', 0) if extracted else 0)
            errores += 1
            try: os.unlink(pdf_path)
            except: pass
            continue

        log(f"  ✓ {extracted['pdf_type']} | {extracted['time_ms']}ms | {len(extracted['markdown'])} chars")

        # 3. LLM fields
        campos, llm_model, tokens = extract_fields_llm(extracted['markdown'])

        if campos and campos.get('criterios_adjudicacion'):
            log(f"  ✓ {llm_model} | {len(campos['criterios_adjudicacion'])} criterios | {tokens} tokens")
        else:
            log(f"  ⚠ {llm_model} — parcial")

        # 4. Save to JSON (loaded to DuckDB by load-json-to-duckdb.py)
        save_to_json(exp['id'], exp['url'], extracted['pdf_type'],
                     extracted['markdown'], campos, 'pdf-inspector', llm_model,
                     extracted['time_ms'])
        extraidos += 1

        try: os.unlink(pdf_path)
        except: pass

        time.sleep(0.5)

    log(f"Done: {extraidos} extraídos, {errores} errores, {skipped} sin PDF")
    read_con.close()


if __name__ == '__main__':
    main()