#!/usr/bin/env python3
"""Check frescura Elicita — dos niveles:

1. VIVO: /api/stats responde (DuckDB accesible vía web, sin lock conflicts).
2. FRESCO: los JSON de ingesta se actualizaron en las últimas MAX_HORAS horas.

Exit 0 = OK | Exit 1 = problema (mensaje con detalle)
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

STATS_URL = 'http://127.0.0.1:4321/api/stats'
DATA_DIR = Path('/root/.openclaw/workspace/projects/elicita/ingesta/data')
MAX_HORAS = 48
# JSONs que deben refrescar en cada ciclo de ingesta
KEY_FILES = [
    'ted_contracts.json',
    'andalucia_contracts.json',
    'galicia_contracts.json',
    'madrid_cm_contracts.json',
]

errores = []

# 1. Web viva
try:
    with urllib.request.urlopen(STATS_URL, timeout=30) as r:
        stats = json.loads(r.read())
    total = stats.get('pipeline', {}).get('total') or stats.get('total')
    print(f'[VIVO] /api/stats OK (total registros pipeline: {total})')
except Exception as e:
    errores.append(f'Web muerta o DuckDB inaccesible: {e}')

# 2. Frescura de ingesta
now = time.time()
for name in KEY_FILES:
    p = DATA_DIR / name
    if not p.exists():
        errores.append(f'Falta {name}')
        continue
    edad_h = (now - p.stat().st_mtime) / 3600
    if edad_h > MAX_HORAS:
        errores.append(f'{name} rancio: {edad_h:.0f}h sin actualizar (umbral {MAX_HORAS}h)')
    else:
        print(f'[FRESCO] {name}: actualizado hace {edad_h:.1f}h')

if errores:
    print('PROBLEMA:')
    for e in errores:
        print(f'  - {e}')
    sys.exit(1)

print('OK: datos frescos y web viva')
sys.exit(0)
