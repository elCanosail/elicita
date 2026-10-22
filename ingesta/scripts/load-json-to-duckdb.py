#!/usr/bin/env python3
"""
load-json-to-duckdb.py — Carga los JSON de ingesta del scheduler en DuckDB.

El scheduler actualiza los JSON cada 4h con datos frescos de las fuentes.
Este script los carga en DuckDB como tablas normalizadas, reemplazando
los Parquets estáticos de BquantFinance (stale desde Feb 2026).

Esquema objetivo (normalizado, mismo que tabla `boe`):
  id, fuente, expediente, organismo, objeto, cpv, cpvs,
  importe_licitacion, importe_adjudicacion,
  fecha_publicacion, fecha_fin, url, estado,
  adjudicatario, nif_adjudicatario

Uso:
  python3 load-json-to-duckdb.py                    # cargar todo
  python3 load-json-to-duckdb.py --source placsp    # cargar solo PLACSP
  python3 load-json-to-duckdb.py --dry-run          # solo reportar
  python3 load-json-to-duckdb.py --rebuild-views    # reconstruir vistas dedup

Cron sugerido: después de cada ciclo del scheduler (cada 4h, offset +15min)
  15 */4 * * * cd .../ingesta && python3 scripts/load-json-to-duckdb.py >> /var/log/elicita-load-json.log 2>&1
"""

import json
import os
import sys
import time
import duckdb
from pathlib import Path
from datetime import datetime, date

DB_PATH = os.environ.get('DUCKDB_PATH', '/var/data/licitaciones/db/licitaciones.duckdb')
DATA_DIR = Path(os.environ.get(
    'ELICITA_INGESTA_DATA_DIR',
    '/root/.openclaw/workspace/projects/elicita/ingesta/data',
))
LOG_FILE = os.environ.get('ELICITA_LOAD_LOG', '/var/log/elicita-load-json.log')

# ─── Esquema normalizado ───────────────────────────────────────────
NORMALIZED_COLS = [
    'id', 'fuente', 'expediente', 'organismo', 'objeto', 'cpv', 'cpvs',
    'importe_licitacion', 'importe_adjudicacion',
    'fecha_publicacion', 'fecha_fin', 'url', 'estado',
    'adjudicatario', 'nif_adjudicatario'
]

# ─── Mapeo JSON → normalizado por fuente ──────────────────────────
# Cada fuente tiene distinto esquema en sus JSON. Esto los normaliza.
SOURCE_CONFIG = {
    'placsp': {
        'file': 'placsp_contracts.json',
        'table': 'placsp_json',
        'fuente_label': 'PLACSP',
        'field_map': {
            'id': 'id',
            'expediente': 'expediente',
            'organismo': 'organismo',
            'objeto': 'titulo',
            'cpvs': 'cpvs',
            'importe_licitacion': 'importe_licitacion',
            'importe_adjudicacion': None,  # PLACSP no trae importe adjudicación
            'fecha_publicacion': 'fecha_publicacion',
            'fecha_fin': 'fecha_fin_presentacion',
            'url': 'url_fuente',
            'estado': 'estado',
            'adjudicatario': None,
            'nif_adjudicatario': None,
        },
    },
    'ted': {
        'file': 'ted_contracts.json',
        'table': 'ted_json',
        'fuente_label': 'TED',
        'field_map': {
            'id': 'id',
            'expediente': 'expediente',
            'organismo': 'organismo',
            'objeto': 'titulo',
            'cpvs': 'cpvs',
            'importe_licitacion': 'importe_licitacion',
            'importe_adjudicacion': None,
            'fecha_publicacion': 'fecha_publicacion',
            'fecha_fin': 'fecha_fin_presentacion',
            'url': 'url_fuente',
            'estado': 'estado',
            'adjudicatario': None,
            'nif_adjudicatario': None,
        },
    },
    'galicia': {
        'file': 'galicia_contracts.json',
        'table': 'galicia_json',
        'fuente_label': 'GALICIA',
        'field_map': {
            'id': 'id',
            'expediente': 'id',
            'organismo': 'organismo',
            'objeto': 'objeto',
            'cpv': 'cpv',
            'cpvs': 'cpvs',
            'importe_licitacion': 'importe_num',
            'importe_adjudicacion': None,
            'fecha_publicacion': 'fecha_publicacion',
            'fecha_fin': 'fecha_fin',
            'url': 'url',
            'estado': 'estado',
            'adjudicatario': 'adjudicatario',
            'nif_adjudicatario': 'nif_adjudicatario',
        },
    },
    'andalucia': {
        'file': 'andalucia_contracts.json',
        'table': 'andalucia_json',
        'fuente_label': 'ANDALUCIA',
        'field_map': {
            'id': 'id',
            'expediente': 'numero_expediente',
            'organismo': 'organismo',
            'objeto': 'titulo',
            'cpv': 'cpv',
            'cpvs': 'cpvs',
            'importe_licitacion': 'importe_num',
            'importe_adjudicacion': 'importe_adjudicacion',
            'fecha_publicacion': 'fecha_publicacion',
            'fecha_fin': 'fecha_fin',
            'url': 'url',
            'estado': 'estado',
            'adjudicatario': 'adjudicatario',
            'nif_adjudicatario': 'nif_adjudicatario',
        },
    },
    'euskadi': {
        'file': 'euskadi_contracts.json',
        'table': 'euskadi_json',
        'fuente_label': 'EUSKADI',
        'field_map': {
            'id': 'id',
            'expediente': 'id',
            'organismo': 'organismo',
            'objeto': 'titulo',
            'cpv': 'cpv',
            'cpvs': 'cpvs',
            'importe_licitacion': 'importe_num',
            'importe_adjudicacion': 'importe_adjudicacion',
            'fecha_publicacion': 'fecha_publicacion',
            'fecha_fin': 'fecha_fin',
            'url': 'url',
            'estado': 'estado',
            'adjudicatario': 'adjudicatario',
            'nif_adjudicatario': 'cif_adjudicatario',
        },
    },
    'asturias': {
        'file': 'asturias_contracts.json',
        'table': 'asturias_json',
        'fuente_label': 'ASTURIAS',
        'field_map': {
            'id': 'id',
            'expediente': 'expediente',
            'organismo': 'organismo',
            'objeto': 'objeto',
            'cpv': 'cpv_principal',
            'cpvs': 'cpvs',
            'importe_licitacion': 'importe_num',
            'importe_adjudicacion': 'importe_adjudicacion',
            'fecha_publicacion': 'fecha_publicacion',
            'fecha_fin': 'fecha_fin',
            'url': 'url',
            'estado': 'estado',
            'adjudicatario': 'adjudicatario',
            'nif_adjudicatario': 'nif_adjudicatario',
        },
    },
    'madrid_cm': {
        'file': 'madrid_cm_contracts.json',
        'table': 'madrid_cm_json',
        'fuente_label': 'MADRID',
        'field_map': {
            'id': 'id',
            'expediente': 'expediente',
            'organismo': 'organismo',
            'objeto': 'titulo',
            'cpv': 'cpv',
            'cpvs': 'cpvs',
            'importe_licitacion': 'importe_num',
            'importe_adjudicacion': 'importe_adjudicacion',
            'fecha_publicacion': 'fecha_publicacion',
            'fecha_fin': 'fecha_fin',
            'url': 'url',
            'estado': 'estado',
            'adjudicatario': 'adjudicatario',
            'nif_adjudicatario': 'nif_adjudicatario',
        },
    },
    'dogv': {
        'file': 'dogv_contracts.json',
        'table': 'valencia_json',
        'fuente_label': 'VALENCIA',
        'field_map': {
            'id': 'id',
            'expediente': 'expediente',
            'organismo': 'organismo',
            'objeto': 'objeto',
            'cpv': 'cpv',
            'cpvs': 'cpvs',
            'importe_licitacion': 'importe_licitacion',
            'importe_adjudicacion': 'importe_adjudicacion',
            'fecha_publicacion': 'fecha_publicacion',
            'fecha_fin': 'fecha_fin',
            'url': 'url',
            'estado': 'estado',
            'adjudicatario': 'adjudicatario',
            'nif_adjudicatario': 'nif_adjudicatario',
        },
    },
    'doga': {
        'file': 'doga_contracts.json',
        'table': 'doga_json',
        'fuente_label': 'ARAGON',
        'field_map': {
            'id': 'id',
            'expediente': 'expediente',
            'organismo': 'organismo',
            'objeto': 'titulo',
            'cpv': 'cpv',
            'cpvs': 'cpvs',
            'importe_licitacion': 'importe_licitacion',
            'importe_adjudicacion': 'importe_adjudicacion',
            'fecha_publicacion': 'fecha_publicacion',
            'fecha_fin': 'fecha_fin',
            'url': 'url',
            'estado': 'estado',
            'adjudicatario': 'adjudicatario',
            'nif_adjudicatario': 'nif_adjudicatario',
        },
    },
    'catalunya': {
        'file': 'catalunya_contracts.json',
        'table': 'catalunya_json',
        'fuente_label': 'CATALUNYA',
        'field_map': {
            'id': 'id',
            'expediente': 'expediente',
            'organismo': 'organismo',
            'objeto': 'titulo',
            'cpv': 'cpv',
            'cpvs': 'cpvs',
            'importe_licitacion': 'importe_num',
            'importe_adjudicacion': 'importe_adjudicacion',
            'fecha_publicacion': 'fecha_publicacion',
            'fecha_fin': 'fecha_fin',
            'url': 'url',
            'estado': 'estado',
            'adjudicatario': 'adjudicatario',
            'nif_adjudicatario': 'nif_adjudicatario',
        },
    },
}

# ─── Utilidades ───────────────────────────────────────────────────

def log(msg):
    ts = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')
    line = f'[{ts}] {msg}'
    print(line, flush=True)
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    with open(LOG_FILE, 'a') as f:
        f.write(line + '\n')


def parse_date(val):
    """Intenta parsear una fecha en varios formatos."""
    if not val or val == '' or val == 'None' or val == 'null':
        return None
    if isinstance(val, (date, datetime)):
        return val if isinstance(val, date) else val.date()
    s = str(val).strip()
    # ISO format
    for fmt in ['%Y-%m-%d', '%Y-%m-%dT%H:%M:%S', '%d/%m/%Y', '%d/%m/%y',
                '%d-%b-%y', '%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S.%fZ']:
        try:
            return datetime.strptime(s.split('.')[0][:19], fmt[:19] if '%f' not in fmt else fmt).date()
        except (ValueError, TypeError):
            continue
    # Try duckdb-style
    try:
        from datetime import datetime as dt
        return dt.fromisoformat(s[:10]).date()
    except (ValueError, TypeError):
        return None


def parse_float(val):
    """Parsea un importe, manejando strings con comas, puntos, etc."""
    if val is None or val == '' or val == 'None' or val == 'null':
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip().replace('€', '').replace(' ', '')
    # Formato español: 1.234.567,89 → 1234567.89
    if ',' in s and '.' in s:
        s = s.replace('.', '').replace(',', '.')
    elif ',' in s:
        s = s.replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return 0.0


def normalize_record(rec, field_map, fuente_label):
    """Normaliza un registro del JSON al esquema unificado."""
    def get_field(mapped_name):
        if mapped_name is None:
            return None
        return rec.get(mapped_name)

    raw_id = get_field(field_map.get('id'))
    if not raw_id:
        return None

    # cpv: primer elemento de cpvs o campo cpv
    cpv = get_field(field_map.get('cpv'))
    cpvs = get_field(field_map.get('cpvs'))
    if not cpv and cpvs:
        if isinstance(cpvs, list):
            cpv = cpvs[0] if cpvs else None
        elif isinstance(cpvs, str):
            cpv = cpvs.split(',')[0].strip() if cpvs else None

    # cpvs como lista
    if isinstance(cpvs, str):
        cpvs_list = [c.strip() for c in cpvs.split(',') if c.strip()]
    elif isinstance(cpvs, list):
        cpvs_list = cpvs
    else:
        cpvs_list = []

    return {
        'id': str(raw_id),
        'fuente': fuente_label,
        'expediente': str(get_field(field_map.get('expediente')) or raw_id),
        'organismo': get_field(field_map.get('organismo')) or '',
        'objeto': get_field(field_map.get('objeto')) or '',
        'cpv': str(cpv) if cpv else None,
        'cpvs': cpvs_list,
        'importe_licitacion': parse_float(get_field(field_map.get('importe_licitacion'))),
        'importe_adjudicacion': parse_float(get_field(field_map.get('importe_adjudicacion'))),
        'fecha_publicacion': parse_date(get_field(field_map.get('fecha_publicacion'))),
        'fecha_fin': parse_date(get_field(field_map.get('fecha_fin'))),
        'url': get_field(field_map.get('url')) or None,
        'estado': get_field(field_map.get('estado')) or 'Publicada',
        'adjudicatario': get_field(field_map.get('adjudicatario')) or None,
        'nif_adjudicatario': get_field(field_map.get('nif_adjudicatario')) or None,
    }


def load_source(con, source_key, config, dry_run=False):
    """Carga un JSON en una tabla DuckDB normalizada."""
    json_path = DATA_DIR / config['file']

    if not json_path.exists() or json_path.stat().st_size == 0:
        log(f'  ⚠️  {source_key}: {config["file"]} no existe o está vacío')
        return 0

    try:
        with open(json_path) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        log(f'  🔴 {source_key}: JSON corrupto — {e}')
        return 0

    # Extraer lista de contratos
    if isinstance(data, dict):
        contratos = data.get('contratos', [])
    else:
        contratos = data

    if not contratos:
        log(f'  ⚠️  {source_key}: 0 contratos en JSON')
        return 0

    # Normalizar registros
    normalized = []
    skipped = 0
    for rec in contratos:
        norm = normalize_record(rec, config['field_map'], config['fuente_label'])
        if norm:
            normalized.append(norm)
        else:
            skipped += 1

    if skipped:
        log(f'  {source_key}: {skipped} registros sin ID, omitidos')

    if dry_run:
        log(f'  [DRY-RUN] {source_key}: {len(normalized)} registros listos para cargar')
        return len(normalized)

    # Cargar en DuckDB via JSON temporal (mucho más eficiente que executemany)
    table = config['table']
    log(f'  {source_key}: cargando {len(normalized)} registros en tabla {table}...')

    import tempfile
    tmp_path = f'/tmp/load_{table}.jsonl'
    with open(tmp_path, 'w') as f:
        for r in normalized:
            # Serializar fechas como ISO string
            row = {
                'id': r['id'],
                'fuente': r['fuente'],
                'expediente': r['expediente'],
                'organismo': r['organismo'],
                'objeto': r['objeto'],
                'cpv': r['cpv'],
                'cpvs': r['cpvs'],
                'importe_licitacion': r['importe_licitacion'],
                'importe_adjudicacion': r['importe_adjudicacion'],
                'fecha_publicacion': r['fecha_publicacion'].isoformat() if r['fecha_publicacion'] else None,
                'fecha_fin': r['fecha_fin'].isoformat() if r['fecha_fin'] else None,
                'url': r['url'],
                'estado': r['estado'],
                'adjudicatario': r['adjudicatario'],
                'nif_adjudicatario': r['nif_adjudicatario'],
            }
            f.write(json.dumps(row) + '\n')

    # Materializar la tanda entrante y fusionarla con el histórico existente.
    # Los conectores trabajan con ventanas recientes; reemplazar la tabla completa
    # borraría años de histórico (especialmente Euskadi/Madrid). El registro nuevo
    # gana por id y la sustitución final ocurre dentro de una transacción.
    incoming = f'{table}__incoming'
    con.execute(f'DROP TABLE IF EXISTS {incoming}')
    con.execute(f'''
        CREATE TABLE {incoming} AS
        SELECT
            id::VARCHAR AS id,
            fuente::VARCHAR AS fuente,
            expediente::VARCHAR AS expediente,
            organismo::VARCHAR AS organismo,
            objeto::VARCHAR AS objeto,
            cpv::VARCHAR AS cpv,
            cpvs::VARCHAR[] AS cpvs,
            importe_licitacion::DOUBLE AS importe_licitacion,
            importe_adjudicacion::DOUBLE AS importe_adjudicacion,
            TRY_CAST(fecha_publicacion AS DATE) AS fecha_publicacion,
            TRY_CAST(fecha_fin AS DATE) AS fecha_fin,
            url::VARCHAR AS url,
            estado::VARCHAR AS estado,
            adjudicatario::VARCHAR AS adjudicatario,
            nif_adjudicatario::VARCHAR AS nif_adjudicatario
        FROM read_json_auto('{tmp_path}', format='newline_delimited')
    ''')

    table_exists = con.execute(
        "SELECT count(*) FROM information_schema.tables "
        "WHERE table_schema = 'main' AND table_name = ? AND table_type = 'BASE TABLE'",
        [table],
    ).fetchone()[0] > 0

    con.execute('BEGIN TRANSACTION')
    try:
        if table_exists:
            con.execute(f'''
                CREATE OR REPLACE TABLE {table} AS
                SELECT id, fuente, expediente, organismo, objeto, cpv, cpvs,
                       importe_licitacion, importe_adjudicacion,
                       fecha_publicacion, fecha_fin, url, estado,
                       adjudicatario, nif_adjudicatario
                FROM (
                    SELECT *, ROW_NUMBER() OVER (
                        PARTITION BY id ORDER BY incoming_priority
                    ) AS rn
                    FROM (
                        SELECT *, 0 AS incoming_priority FROM {incoming}
                        UNION ALL BY NAME
                        SELECT *, 1 AS incoming_priority FROM {table}
                    ) merged
                ) ranked
                WHERE rn = 1
            ''')
        else:
            con.execute(f'ALTER TABLE {incoming} RENAME TO {table}')
            incoming = None
        con.execute('COMMIT')
    except Exception:
        con.execute('ROLLBACK')
        raise
    finally:
        if incoming:
            con.execute(f'DROP TABLE IF EXISTS {incoming}')
        os.remove(tmp_path)

    count = con.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
    log(f'  ✅ {source_key}: {count:,} registros cargados en {table}')

    return count


def rebuild_unified_view(con):
    """Reconstruye la vista contratos_unificados usando las tablas JSON."""
    log('  Reconstruyendo vista contratos_json_unificados...')

    # UNION ALL de todas las tablas JSON normalizadas
    tables = [cfg['table'] for cfg in SOURCE_CONFIG.values()]
    union_parts = []
    for t in tables:
        union_parts.append(f'SELECT * FROM {t}')

    union_sql = ' UNION ALL '.join(union_parts)

    con.execute('DROP VIEW IF EXISTS contratos_json_unificados')
    con.execute(f'CREATE VIEW contratos_json_unificados AS {union_sql}')

    count = con.execute('SELECT COUNT(*) FROM contratos_json_unificados').fetchone()[0]
    log(f'  ✅ contratos_json_unificados: {count:,} registros')

    # Crear vista deduplicada
    log('  Reconstruyendo vista contratos_json_saneados...')
    con.execute('DROP VIEW IF EXISTS contratos_json_saneados')
    con.execute('''
        CREATE VIEW contratos_json_saneados AS
        WITH ranked AS (
            SELECT *,
                ROW_NUMBER() OVER (
                    PARTITION BY id
                    ORDER BY
                        CASE estado
                            WHEN 'Resuelta' THEN 1
                            WHEN 'Formalizada' THEN 2
                            WHEN 'Adjudicada' THEN 3
                            WHEN 'En ejecución' THEN 4
                            ELSE 5
                        END,
                        importe_adjudicacion DESC NULLS LAST,
                        fecha_publicacion DESC NULLS LAST
                ) AS rn,
                -- Dedup secundaria: mismo anuncio publicado con ids distintos
                -- (p.ej. PLACE:<num> vs PLACSP:<expediente>:<organo>) en fuentes agregadas.
                CASE WHEN expediente IS NOT NULL AND expediente != ''
                     AND organismo IS NOT NULL AND organismo != ''
                     THEN expediente || '|' || organismo
                     ELSE 'id:' || id END AS dedup_key
            FROM contratos_json_unificados
            WHERE importe_licitacion < 5000000000
              AND importe_adjudicacion < 5000000000
              AND id IS NOT NULL
        ),
        ranked2 AS (
            SELECT *
            FROM (
                SELECT *,
                    ROW_NUMBER() OVER (
                        PARTITION BY dedup_key
                        ORDER BY
                            CASE WHEN fuente = 'PLACSP' THEN 0 ELSE 1 END,
                            CASE estado
                                WHEN 'Resuelta' THEN 1
                                WHEN 'Formalizada' THEN 2
                                WHEN 'Adjudicada' THEN 3
                                WHEN 'En ejecución' THEN 4
                                ELSE 5
                            END,
                            importe_adjudicacion DESC NULLS LAST,
                            fecha_publicacion DESC NULLS LAST
                    ) AS rn2
                FROM ranked WHERE rn = 1
            )
        )
        SELECT id, fuente, expediente, organismo, objeto, cpv, cpvs,
               importe_licitacion, importe_adjudicacion,
               fecha_publicacion, fecha_fin, url, estado,
               adjudicatario, nif_adjudicatario
        FROM ranked2
        WHERE rn2 = 1
    ''')

    count_saneados = con.execute('SELECT COUNT(*) FROM contratos_json_saneados').fetchone()[0]
    log(f'  ✅ contratos_json_saneados: {count_saneados:,} registros (deduplicados)')

    # Vista unificada: datos históricos ya no existen como tabla independiente;
    # usamos solo el dataset incremental saneado como fuente de verdad.
    log('  Reconstruyendo vista contratos_vivos...')
    con.execute('DROP VIEW IF EXISTS contratos_vivos')
    con.execute('''
        CREATE VIEW contratos_vivos AS
        SELECT id, fuente, expediente, organismo, objeto, cpv, cpvs,
               importe_licitacion, importe_adjudicacion,
               fecha_publicacion, fecha_fin, url, estado,
               adjudicatario, nif_adjudicatario
        FROM contratos_json_saneados
    ''')
    count_vivos = con.execute('SELECT COUNT(*) FROM contratos_vivos').fetchone()[0]
    log(f'  ✅ contratos_vivos: {count_vivos:,} registros (histórico + incremental)')


def main():
    dry_run = '--dry-run' in sys.argv
    rebuild_views = '--rebuild-views' in sys.argv
    source_filter = None
    for arg in sys.argv[1:]:
        if arg.startswith('--source='):
            source_filter = arg.split('=')[1]
        elif arg == '--source':
            source_filter = sys.argv[sys.argv.index(arg) + 1]

    log('=' * 60)
    log('load-json-to-duckdb.py — Carga JSON ingesta → DuckDB')
    log(f'Modo: {"DRY-RUN" if dry_run else "APPLY"}'
        f'{f", source={source_filter}" if source_filter else ""}')
    log('=' * 60)

    if not os.path.exists(DB_PATH):
        log(f'🔴 DuckDB no existe: {DB_PATH}')
        sys.exit(1)

    con = duckdb.connect(DB_PATH)
    total_start = time.time()
    total_records = 0

    for source_key, config in SOURCE_CONFIG.items():
        if source_filter and source_filter != source_key:
            continue
        t0 = time.time()
        count = load_source(con, source_key, config, dry_run)
        elapsed = time.time() - t0
        total_records += count
        if count > 0 and not dry_run:
            log(f'    {source_key}: {elapsed:.1f}s')

    if not dry_run and (not source_filter or rebuild_views):
        rebuild_unified_view(con)

    con.close()
    elapsed_total = time.time() - total_start
    log(f'Total: {total_records:,} registros en {elapsed_total:.1f}s')
    log('=' * 60)


if __name__ == '__main__':
    main()