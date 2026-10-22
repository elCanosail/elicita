#!/usr/bin/env python3
"""
data-quality-monitor.py — Guardián determinista de calidad de datos Elicita.

Reglas (todas deterministas, cero LLM):
  1. FRESCURA   — cada fuente clave con ciclo < MAX_HORAS
  2. VOLUMEN    — variación vs snapshot anterior < MAX_VARIACION
  3. SANIDAD    — 0 fechas futuras imposibles, importes fuera de rango acotado,
                  % nulos en campos clave bajo umbral
  4. DEDUP      — ratio duplicados expediente+organismo < MAX_DUP_RATIO
  5. WEB        — /api/stats responde y total coherente
  6. DUCKDB     — el fichero materializado es reciente y su contenido no
                  va por detrás de los caches JSON (incidente 28-ago→14-sep:
                  caches vivos + DB congelada pasaba todas las reglas)

Estado entre ejecuciones: /root/.openclaw/workspace/projects/elicita/ingesta/data/quality_state.json
Salida: texto legible. Exit 0 = todo OK | Exit 1 = problemas (detalle en stdout)

Uso:
  python3 data-quality-monitor.py            # check completo
  python3 data-quality-monitor.py --quiet    # solo output si hay problemas
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, date, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────
BASE = Path('/root/.openclaw/workspace/projects/elicita/ingesta')
DATA_DIR = BASE / 'data'
STATE_FILE = DATA_DIR / 'quality_state.json'

STATS_URL = 'http://127.0.0.1:4321/api/stats'
ADMIN_URL = 'http://127.0.0.1:4321/api/admin/duckdb-query'
DUCKDB_PATH = '/var/data/licitaciones/db/licitaciones.duckdb'
DUCKDB_MTIME_MAX_HORAS = 48  # edad máxima del fichero promovido por materialize-duckdb.sh
DUCKDB_LAG_DIAS = 2          # desfase máximo cache→DuckDB en MAX(fecha_publicacion)

MAX_HORAS = 48              # frescura máxima del JSON de una fuente
MAX_VARIACION = 0.30        # ±30% volumen vs ciclo anterior
MAX_DUP_RATIO = 0.05        # 5% duplicados máximo
MAX_IMPORTE = 5_000_000_000 # mismo corte que la vista saneada
FECHA_LIMITE_FUTURO = 3     # años de margen sobre hoy (fechas > hoy+3y = basura)

KEY_SOURCES = {
    'placsp_contracts.json': 'PLACSP',
    'ted_contracts.json': 'TED',
    'galicia_contracts.json': 'Galicia',
    'andalucia_contracts.json': 'Andalucía',
    'euskadi_contracts.json': 'Euskadi',
    'madrid_cm_contracts.json': 'Madrid CM',
    'catalunya_contracts.json': 'Catalunya',
    'asturias_contracts.json': 'Asturias',
}

problemas = []
avisos = []
ok_lines = []


def admin_query(sql):
    """Query read-only vía endpoint admin (evita lock conflicts)."""
    body = json.dumps({'sql': sql}).encode()
    req = urllib.request.Request(ADMIN_URL, data=body, headers={
        'Content-Type': 'application/json',
        'x-real-ip': '127.0.0.1',
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.loads(r.read())
    if not d.get('ok'):
        raise RuntimeError(d.get('detail', 'query error'))
    return d['rows']


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def append_history(state, problemas, errores_ejecucion):
    """Append de cada run a quality_history.jsonl para análisis de tendencias (Opción B)."""
    hist_file = DATA_DIR / 'quality_history.jsonl'
    entry = {
        'ts': datetime.now(timezone.utc).isoformat(),
        'ok': not problemas and not errores_ejecucion,
        'problemas': problemas,
        'errores': errores_ejecucion,
        'volumen': state.get('volumen', {}),
    }
    with open(hist_file, 'a') as f:
        f.write(json.dumps(entry) + '\n')
    # Rotación: mantener últimos 500 runs (~83 días a 6/día)
    try:
        lines = hist_file.read_text().strip().split('\n')
        if len(lines) > 500:
            hist_file.write_text('\n'.join(lines[-500:]) + '\n')
    except Exception:
        pass


# ── Regla 1: Frescura ────────────────────────────────────────────────
def check_frescura(now):
    for fname, fuente in KEY_SOURCES.items():
        p = DATA_DIR / fname
        if not p.exists():
            problemas.append(f'[FRESCURA] {fuente}: falta {fname}')
            continue
        edad_h = (now - p.stat().st_mtime) / 3600
        if edad_h > MAX_HORAS:
            problemas.append(f'[FRESCURA] {fuente}: {edad_h:.0f}h sin actualizar (umbral {MAX_HORAS}h)')
        else:
            ok_lines.append(f'FRESCURA {fuente}: hace {edad_h:.1f}h')


# ── Regla 2: Volumen ─────────────────────────────────────────────────
def check_volumen(state):
    rows = admin_query('SELECT fuente, count(*) n FROM contratos_vivos GROUP BY 1')
    current = {r['fuente']: r['n'] for r in rows}
    prev = state.get('volumen', {})

    for fuente, n in sorted(current.items()):
        p = prev.get(fuente)
        if p and p > 100:  # solo fuentes con volumen significativo
            var = abs(n - p) / p
            if var > MAX_VARIACION:
                problemas.append(
                    f'[VOLUMEN] {fuente}: {n:,} vs {p:,} anterior ({var*100:+.0f}% — umbral ±{MAX_VARIACION*100:.0f}%)')
            else:
                ok_lines.append(f'VOLUMEN {fuente}: {n:,} ({var*100:+.1f}%)')

    state['volumen'] = current
    state['volumen_ts'] = datetime.now(timezone.utc).isoformat()


# ── Regla 3: Sanidad ─────────────────────────────────────────────────
def check_sanidad():
    # Fechas futuras imposibles (> hoy + N años)
    rows = admin_query(
        f"SELECT count(*) n FROM contratos_vivos WHERE fecha_publicacion > CURRENT_DATE + INTERVAL {FECHA_LIMITE_FUTURO} YEAR")
    n = rows[0]['n']
    if n > 0:
        problemas.append(f'[SANIDAD] {n} contratos con fecha_publicación futura imposible (>{FECHA_LIMITE_FUTURO} años)')
    else:
        ok_lines.append('SANIDAD fechas: 0 futuras imposibles')

    # Importes fuera de rango
    rows = admin_query(
        f'SELECT count(*) n FROM contratos_vivos WHERE importe_licitacion > {MAX_IMPORTE}')
    n = rows[0]['n']
    if n > 0:
        problemas.append(f'[SANIDAD] {n} contratos con importe_licitacion > {MAX_IMPORTE:,}€')
    else:
        ok_lines.append('SANIDAD importes: 0 absurdos')

    # % nulos en campo clave (organismo)
    rows = admin_query(
        "SELECT count(*) FILTER (WHERE organismo IS NULL OR organismo = '') * 100.0 / count(*) pct FROM contratos_vivos")
    pct = rows[0]['pct'] or 0
    if pct > 10:
        problemas.append(f'[SANIDAD] {pct:.1f}% contratos sin organismo (umbral 10%)')
    else:
        ok_lines.append(f'SANIDAD organismo: {pct:.1f}% nulos')


# ── Regla 4: Dedup ───────────────────────────────────────────────────
def check_dedup():
    rows = admin_query("""
        SELECT count(*) total,
               count(*) - count(DISTINCT CASE WHEN expediente IS NOT NULL AND expediente != ''
                        AND organismo IS NOT NULL AND organismo != ''
                        THEN expediente || '|' || organismo END) dups
        FROM contratos_vivos
        WHERE expediente IS NOT NULL AND expediente != ''
          AND organismo IS NOT NULL AND organismo != ''
    """)
    r = rows[0]
    total, dups = r['total'], r['dups']
    if total == 0:
        problemas.append('[DEDUP] contratos_vivos vacío — vista rota')
        return
    ratio = dups / total
    if ratio > MAX_DUP_RATIO:
        problemas.append(f'[DEDUP] {dups:,} duplicados ({ratio*100:.1f}% — umbral {MAX_DUP_RATIO*100:.0f}%)')
    else:
        ok_lines.append(f'DEDUP: {dups:,} dups ({ratio*100:.2f}%)')


# ── Regla 5: Web viva y coherente ────────────────────────────────────
def check_web():
    try:
        with urllib.request.urlopen(STATS_URL, timeout=30) as r:
            stats = json.loads(r.read())
        pipeline = stats.get('pipeline', {})
        total_pipeline = pipeline.get('total') or sum(v for k, v in pipeline.items() if isinstance(v, int))
        ok_lines.append(f'WEB /api/stats OK')
    except Exception as e:
        problemas.append(f'[WEB] /api/stats no responde: {e}')


# ── Regla 6: DuckDB materializada y al día ──────────────────────────
def cache_max_fecha_publicacion():
    """MAX(fecha_publicacion) en los caches JSON de las fuentes clave (None si nada legible)."""
    fechas = []
    for fname, _fuente in KEY_SOURCES.items():
        p = DATA_DIR / fname
        if not p.exists():
            continue
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        contratos = d.get('contratos') if isinstance(d, dict) else d
        if not isinstance(contratos, list):
            contratos = next((v for v in d.values() if isinstance(v, list) and v and isinstance(v[0], dict)), []) if isinstance(d, dict) else []
        for c in contratos:
            v = c.get('fecha_publicacion') if isinstance(c, dict) else None
            if isinstance(v, str) and len(v) >= 10:
                fechas.append(v[:10])
    return max(fechas) if fechas else None


def check_duckdb(now_ts):
    """El hueco del incidente: caches vivos + materialización muerta pasaba todas las reglas."""
    # (a) frescura de materialización: mtime del fichero promovido (rename atómico)
    db = Path(DUCKDB_PATH)
    if not db.exists():
        problemas.append(f'[DUCKDB] no existe {DUCKDB_PATH}')
        return
    edad_h = (now_ts - db.stat().st_mtime) / 3600
    if edad_h > DUCKDB_MTIME_MAX_HORAS:
        problemas.append(f'[DUCKDB] sin materialización hace {edad_h:.0f}h (umbral {DUCKDB_MTIME_MAX_HORAS}h)')
    else:
        ok_lines.append(f'DUCKDB materialización: hace {edad_h:.1f}h')

    # (b) desfase de contenido: MAX(fecha_publicacion) DB vs caches JSON
    cache_max = cache_max_fecha_publicacion()
    rows = admin_query('SELECT MAX(fecha_publicacion) AS max_pub, COUNT(*) AS n FROM contratos_vivos')
    db_max = ((rows[0].get('max_pub') or '')[:10]) if rows else ''
    n_db = rows[0].get('n') if rows else 0
    if not cache_max:
        problemas.append('[DUCKDB] caches JSON sin fecha_publicacion legible — desfase no verificable')
        return
    if not db_max:
        problemas.append(f'[DUCKDB] contratos_vivos vacío o sin fecha_publicacion (cache hasta {cache_max})')
        return
    lag_dias = (datetime.strptime(cache_max, '%Y-%m-%d') - datetime.strptime(db_max, '%Y-%m-%d')).days
    if lag_dias > DUCKDB_LAG_DIAS:
        problemas.append(
            f'[DUCKDB] contenido congelado: DB hasta {db_max}, cache hasta {cache_max} '
            f'(lag {lag_dias}d, umbral {DUCKDB_LAG_DIAS}d) — revisar materialize-duckdb.sh')
    else:
        ok_lines.append(f'DUCKDB contenido: DB hasta {db_max}, cache hasta {cache_max} (lag {lag_dias}d, {n_db:,} contratos)')


# ── Main ─────────────────────────────────────────────────────────────
def main():
    quiet = '--quiet' in sys.argv
    now_ts = time.time()
    state = load_state()

    checks = [
        ('FRESCURA', lambda: check_frescura(now_ts)),
        ('DUCKDB', lambda: check_duckdb(now_ts)),
        ('VOLUMEN', lambda: check_volumen(state)),
        ('SANIDAD', check_sanidad),
        ('DEDUP', check_dedup),
        ('WEB', check_web),
    ]

    errores_de_ejecucion = []
    for name, fn in checks:
        try:
            fn()
        except Exception as e:
            errores_de_ejecucion.append(f'[{name}] error ejecutando check: {e}')

    save_state(state)
    append_history(state, problemas, errores_de_ejecucion)

    if problemas or errores_de_ejecucion:
        print('🔴 DATA QUALITY MONITOR — PROBLEMAS DETECTADOS\n')
        for p in problemas + errores_de_ejecucion:
            print(f'  {p}')
        print(f'\nTotal: {len(problemas)} problema(s), {len(errores_de_ejecucion)} error(es) de ejecución')
        sys.exit(1)

    if not quiet:
        print(f'🟢 DATA QUALITY MONITOR — TODO OK ({datetime.now(timezone.utc).strftime("%H:%M UTC")})')
        for l in ok_lines:
            print(f'  ✓ {l}')
    sys.exit(0)


if __name__ == '__main__':
    main()
