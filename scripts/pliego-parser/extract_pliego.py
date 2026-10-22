#!/usr/bin/env python3
"""
Pliego extractor para Elicita — POC 5 expedientes
"""
import subprocess, json, re, os, time
from pathlib import Path

WORK_DIR = Path("/tmp/pliegos_poc")
WORK_DIR.mkdir(exist_ok=True)

# Lee OpenRouter key
OPENROUTER_KEY = ""
env_file = Path("/root/.openclaw/workspace/.env")
if env_file.exists():
    for line in env_file.read_text().splitlines():
        if line.startswith("OPENROUTER_API_KEY="):
            OPENROUTER_KEY = line.split("=", 1)[1].strip()

def get_sample_expedientes(n=5):
    code = f"""
import duckdb, json
con = duckdb.connect('/var/data/licitaciones/db/licitaciones.duckdb', read_only=True)
rows = con.execute(\"\"\"
    SELECT id, expediente, objeto, organo_contratante, importe_sin_iva, url
    FROM nacional
    WHERE importe_sin_iva BETWEEN 100000 AND 2000000
      AND fecha_publicacion > '2024-06-01'
      AND url LIKE '%contrataciondelestado.es/wps/poc%deeplink:detalle_licitacion%'
      AND url NOT LIKE '%sindicacion%'
    ORDER BY fecha_publicacion DESC
    LIMIT {n}
\"\"\").fetchall()
print(json.dumps([{{'id':r[0],'expediente':r[1],'objeto':str(r[2])[:100],'organo':r[3],'importe':r[4],'url':r[5]}} for r in rows]))
"""
    result = subprocess.run(['python3', '-c', code], capture_output=True, text=True)
    return json.loads(result.stdout)

def get_doc_ids_from_page(url):
    """Devuelve lista de (tipoDoc, idDocumento, DocumentIdParam) de la página"""
    subprocess.run(['npx', 'agent-browser', 'open', url],
                   capture_output=True, text=True, timeout=15)
    time.sleep(5)

    result = subprocess.run(['npx', 'agent-browser', 'eval', '''
        const html = document.body.innerHTML;
        // Onclicks con tipoDoc y idDocumento
        const entries = Array.from(document.querySelectorAll('[onclick]'))
            .map(el => {
                const oc = el.getAttribute('onclick') || '';
                const tipoM = oc.match(/\\['tipoDoc','([^']+)'\\]/);
                const idM = oc.match(/\\['idDocumento','(\\d+)'\\]/);
                if (tipoM && idM) return {tipoDoc: tipoM[1], idDocumento: parseInt(idM[1])};
                return null;
            }).filter(Boolean);
        
        // DocumentIdParams del HTML (en orden de aparición)
        const docIdRe = /DocumentIdParam=([^"'&\\s<>]+)/g;
        const docIds = [];
        let m;
        while ((m = docIdRe.exec(html)) !== null) {
            docIds.push(decodeURIComponent(m[1]));
        }
        
        JSON.stringify({entries, docIds});
    '''], capture_output=True, text=True, timeout=15)

    raw = result.stdout.strip()
    if raw.startswith('"'):
        raw = json.loads(raw)
    try:
        data = json.loads(raw)
    except:
        return [], []
    return data.get('entries', []), data.get('docIds', [])

def download_pdf(doc_id_param, output_path):
    url = (
        "https://contrataciondelestado.es/wps/wcm/connect/PLACE_es/Site/area/docAccCmpnt"
        f"?srv=cmpnt&cmpntname=GetDocumentsById&source=library&DocumentIdParam={doc_id_param}"
    )
    subprocess.run([
        'curl', '-s', '-L', '-o', str(output_path),
        '-H', 'User-Agent: Mozilla/5.0',
        '-H', 'Referer: https://contrataciondelestado.es/',
        '--max-time', '30', url
    ], capture_output=True)
    return output_path.exists() and output_path.stat().st_size > 1000

def parse_pdf(pdf_path):
    r = subprocess.run(
        ['npx', '@llamaindex/liteparse', str(pdf_path), '--format', 'text'],
        capture_output=True, text=True, timeout=60
    )
    return r.stdout[:6000]

def extract_fields(text, objeto):
    import urllib.request
    prompt = f"""Analiza este fragmento de pliego de contratación pública española.

OBJETO: {objeto}

TEXTO:
{text[:4000]}

Extrae en JSON (sin texto extra):
{{
  "criterios_adjudicacion": [{{"nombre": "...", "peso_pct": 0}}],
  "solvencia_economica": "descripción o null",
  "solvencia_tecnica": "descripción o null",
  "plazo_ejecucion": "X meses o null",
  "garantia_definitiva": "X% o null",
  "condiciones_especiales": [],
  "notas": "..."
}}"""

    payload = json.dumps({
        "model": "anthropic/claude-haiku-4-5",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()

    req = urllib.request.Request(
        'https://openrouter.ai/api/v1/chat/completions',
        data=payload,
        headers={
            'Authorization': f'Bearer {OPENROUTER_KEY}',
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://elicita.es'
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            content = data['choices'][0]['message']['content']
            # Extraer JSON del contenido
            m = re.search(r'\{.*\}', content, re.DOTALL)
            return json.loads(m.group()) if m else {"raw": content}
    except Exception as e:
        return {"error": str(e)}

def main():
    print("🔍 Obteniendo muestra de expedientes PLACE...")
    exps = get_sample_expedientes(5)
    print(f"✓ {len(exps)} expedientes\n")

    results = []
    for i, exp in enumerate(exps):
        tag = f"[{i+1}/5]"
        print(f"{tag} {exp['expediente']} | {exp['objeto'][:55]} | {exp['importe']:,.0f}€")

        # 1. Obtener doc IDs
        print(f"  → Abriendo PLACE...")
        try:
            entries, doc_ids = get_doc_ids_from_page(exp['url'])
        except Exception as e:
            print(f"  ✗ Error browser: {e}")
            results.append({**exp, 'error': str(e), 'stage': 'browser'})
            continue

        print(f"  ✓ {len(entries)} entries, {len(doc_ids)} DocumentIdParams")
        for e2 in entries:
            print(f"    tipoDoc={e2['tipoDoc']} idDoc={e2['idDocumento']}")

        # Identificar el Pliego (DOC_CD)
        pliego_entry = next((e2 for e2 in entries if e2['tipoDoc'] == 'DOC_CD'), None)
        if pliego_entry and pliego_entry['idDocumento'] < len(doc_ids):
            doc_id = doc_ids[pliego_entry['idDocumento']]
        elif len(doc_ids) > 1:
            doc_id = doc_ids[1]  # Índice 1 suele ser el pliego
            print(f"  ⚠ DOC_CD no encontrado, usando índice 1")
        else:
            print(f"  ✗ Sin DocumentIdParam disponible")
            results.append({**exp, 'error': 'no_doc_id', 'stage': 'docid', 'entries': entries})
            continue

        print(f"  ✓ DocId: {doc_id[:50]}...")

        # 2. Descargar
        pdf_path = WORK_DIR / f"pliego_{i+1}.pdf"
        print(f"  → Descargando PDF...")
        try:
            ok = download_pdf(doc_id, pdf_path)
            if not ok:
                # Probar con índice diferente
                for alt_idx in range(min(len(doc_ids), 4)):
                    ok = download_pdf(doc_ids[alt_idx], pdf_path)
                    if ok:
                        print(f"  ✓ Descargado con índice alternativo {alt_idx}")
                        break
            if not ok:
                print(f"  ✗ Descarga fallida")
                results.append({**exp, 'error': 'download_failed', 'stage': 'download'})
                continue
            kb = pdf_path.stat().st_size // 1024
            print(f"  ✓ PDF {kb} KB")
        except Exception as e:
            print(f"  ✗ Error: {e}")
            results.append({**exp, 'error': str(e), 'stage': 'download'})
            continue

        # 3. Parsear
        print(f"  → Parseando con liteparse...")
        try:
            text = parse_pdf(pdf_path)
            words = len(text.split())
            print(f"  ✓ {words} palabras extraídas")
            if words < 50:
                print(f"  ⚠ Texto muy corto — posible escaneado/imagen")
        except Exception as e:
            print(f"  ✗ Parse error: {e}")
            results.append({**exp, 'error': str(e), 'stage': 'parse'})
            continue

        # 4. Extraer con LLM
        print(f"  → Extrayendo campos con Claude Haiku...")
        fields = extract_fields(text, exp['objeto'])
        if 'error' in fields:
            print(f"  ✗ LLM error: {fields['error']}")
        else:
            print(f"  ✓ Criterios: {fields.get('criterios_adjudicacion', [])}")
            print(f"  ✓ Plazo: {fields.get('plazo_ejecucion', 'N/A')}")

        results.append({
            **exp,
            'doc_id_prefix': doc_id[:60],
            'pdf_kb': pdf_path.stat().st_size // 1024,
            'text_words': words,
            'extracted': fields
        })
        print()

    # Guardar
    out = WORK_DIR / "results.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2))

    print(f"\n{'='*60}")
    ok = [r for r in results if 'extracted' in r]
    print(f"✓ {len(ok)}/{len(results)} con extracción completada")
    print(f"📁 Resultados: {out}")
    print(f"📁 PDFs: {WORK_DIR}/pliego_*.pdf")
    print('='*60)

    for r in ok:
        if 'error' not in r.get('extracted', {}):
            print(f"\n📄 {r['expediente']}")
            print(f"   Objeto: {r['objeto'][:70]}")
            ext = r['extracted']
            if ext.get('criterios_adjudicacion'):
                for c in ext['criterios_adjudicacion']:
                    print(f"   ✦ {c.get('nombre','?')} → {c.get('peso_pct','?')}%")
            print(f"   Plazo: {ext.get('plazo_ejecucion','N/A')}")
            print(f"   Solvencia eco: {str(ext.get('solvencia_economica','N/A'))[:80]}")

if __name__ == '__main__':
    main()
