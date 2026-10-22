#!/usr/bin/env python3
"""
match-perfiles.py — Matching perfil-contrato para Elicita.

Empareja perfiles activos de ia_perfiles con contratos recientes de
contratos_vivos usando SQL puro (sin LLM), genera un score 0-100 y
un motivo humano, e inserta en ia_matching_results.

El script trabaja sobre una copia temporal de DuckDB para evitar locks
del servidor MCP/Node, y escribe matches en la base original con retries.

Uso:
  python3 match-perfiles.py                # matching normal
  python3 match-perfiles.py --dry-run      # solo reportar, no insertar
  python3 match-perfiles.py --force-test   # asegura perfil test-matching

Score:
  +40 CPV overlap
  +25 organismo exacto (si perfil define organismos)
  +20 importe en rango
  +15 sector keyword en título/objeto
  umbral de inserción: >30
"""

import os
import sys
import time
import shutil
import json
import duckdb
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = '/var/data/licitaciones/db/licitaciones.duckdb'
WORK_DIR = Path('/tmp/matching_ingesta')
WORK_DIR.mkdir(exist_ok=True)
TMP_DB = str(WORK_DIR / 'licitaciones_matching.duckdb')
LOG_FILE = '/var/log/elicita-matching.log'

SCORE_CPV = 40
SCORE_ORGANISMO = 25
SCORE_IMPORTE = 20
SCORE_SECTOR = 15
SCORE_MIN = 30


def log(msg):
    ts = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')
    line = f'[{ts}] {msg}'
    print(line, flush=True)
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    with open(LOG_FILE, 'a') as f:
        f.write(line + '\n')


def copy_db(src, dst):
    """Copia la base a un fichero temporal para evitar lock de lectura."""
    if os.path.exists(dst):
        try:
            os.remove(dst)
        except Exception as e:
            log(f'  ⚠️ no se pudo borrar DB temporal anterior: {e}')
    shutil.copy2(src, dst)


def get_ro_conn():
    """Abre la base de ingesta en READ-ONLY (el web ya no la bloquea en RW).
    Adjunta web-state en RO para leer perfiles y matching previos."""
    web_state = os.environ.get('DUCKDB_WEB_STATE_PATH', '/var/data/licitaciones/db/web-state.duckdb')
    con = duckdb.connect(DB_PATH, read_only=True)
    for attempt in range(8):
        try:
            con.execute(f"ATTACH '{web_state}' AS ws (READ_ONLY)")
            break
        except Exception as e:
            if attempt == 7 or 'lock' not in str(e).lower():
                raise
            log(f'  web-state locked, retry {attempt + 1}/8...')
            time.sleep(1)
    return con


def get_write_conn(retries=5, delay=3):
    """Escritura sobre WEB-STATE (perfiles, matching). Nunca sobre la base de ingesta."""
    web_state = os.environ.get('DUCKDB_WEB_STATE_PATH', '/var/data/licitaciones/db/web-state.duckdb')
    for attempt in range(retries):
        try:
            return duckdb.connect(web_state)
        except Exception as e:
            if attempt < retries - 1:
                log(f'  web-state locked, retry {attempt + 1}/{retries}...')
                time.sleep(delay)
            else:
                raise


def ensure_test_profile(con_write):
    """Crea/actualiza el perfil de test si se solicita con --force-test."""
    con_write.execute("""
        INSERT OR REPLACE INTO ia_perfiles
        (user_id, email, nombre, cpvs, organismos, fuentes, importe_min, importe_max, sectores, activo, created_at, updated_at)
        VALUES ('test-matching', 'test-matching@elicita.es', 'Test Matching',
                ['48000000', '72000000'], [], [], 50000.0, 500000.0,
                ['software', 'sistemas'], true, now(), now())
    """)
    log('  Perfil test-matching asegurado')


def get_active_profiles(con_ro):
    return con_ro.execute("""
        SELECT user_id, email, nombre, cpvs, organismos, fuentes,
               importe_min, importe_max, sectores
        FROM ws.ia_perfiles
        WHERE activo = true
    """).fetchall()


def build_contratos_query(profile):
    """Construye WHERE y params para buscar contratos candidatos."""
    conditions = ["c.fecha_publicacion >= ?"]
    params = [(datetime.utcnow() - timedelta(days=7)).date().isoformat()]

    # CPV overlap: al menos un CPV del perfil aparece en cpvs del contrato
    cpvs = profile[3] or []
    cpv_prefixes = []
    for c in cpvs:
        s = str(c).replace('.0', '').replace(' ', '').strip()
        if s:
            cpv_prefixes.append(s[:5])
            cpv_prefixes.append(s[:2])  # familia amplia, cubre 48000000 -> 48

    if cpv_prefixes:
        # Usamos unnest de perfil cpvs en subconsulta para evitar parámetros dinámicos
        pass

    # Organismos
    organismos = profile[4] or []
    org_terms = [str(o).strip().lower() for o in organismos if str(o).strip()]
    if org_terms:
        placeholders = ','.join(['?'] * len(org_terms))
        conditions.append(f"LOWER(c.organismo) IN ({placeholders})")
        params.extend(org_terms)

    # Importe
    importe_min = profile[6]
    importe_max = profile[7]
    if importe_min is not None and importe_min > 0:
        conditions.append("c.importe_licitacion >= ?")
        params.append(float(importe_min))
    if importe_max is not None and importe_max > 0:
        conditions.append("c.importe_licitacion <= ?")
        params.append(float(importe_max))

    return ' AND '.join(conditions), params


def find_matches_for_profile(con_ro, profile):
    """Busca contratos no matcheados y calcula score en SQL."""
    user_id = profile[0]
    cpvs = profile[3] or []
    organismos = profile[4] or []
    sectores = profile[8] or []
    importe_min = profile[6]
    importe_max = profile[7]

    # Tabla temporal con los CPVs del perfil expandidos (prefijos de 5 y 2 dígitos)
    cpv_rows = []
    for c in cpvs:
        s = str(c).replace('.0', '').replace(' ', '').strip()
        if not s:
            continue
        cpv_rows.append((s[:5],))
        cpv_rows.append((s[:2],))

    con_ro.execute("DROP TABLE IF EXISTS tmp_profile_cpvs")
    con_ro.execute("CREATE TEMP TABLE tmp_profile_cpvs (prefix VARCHAR)")
    if cpv_rows:
        con_ro.executemany("INSERT INTO tmp_profile_cpvs VALUES (?)", cpv_rows)

    # Tabla temporal con sectores del perfil
    sector_rows = [(str(s).strip().lower(),) for s in sectores if str(s).strip()]
    con_ro.execute("DROP TABLE IF EXISTS tmp_profile_sectors")
    con_ro.execute("CREATE TEMP TABLE tmp_profile_sectors (keyword VARCHAR)")
    if sector_rows:
        con_ro.executemany("INSERT INTO tmp_profile_sectors VALUES (?)", sector_rows)

    # Tabla temporal con organismos exactos del perfil
    org_rows = [(str(o).strip().lower(),) for o in organismos if str(o).strip()]
    con_ro.execute("DROP TABLE IF EXISTS tmp_profile_orgs")
    con_ro.execute("CREATE TEMP TABLE tmp_profile_orgs (org VARCHAR)")
    if org_rows:
        con_ro.executemany("INSERT INTO tmp_profile_orgs VALUES (?)", org_rows)

    since = (datetime.utcnow() - timedelta(days=7)).date().isoformat()

    sql = """
        WITH candidatos AS (
            SELECT
                c.id,
                c.fuente,
                c.organismo,
                c.objeto,
                c.cpv,
                c.cpvs,
                c.importe_licitacion,
                c.fecha_publicacion
            FROM contratos_vivos c
            WHERE c.fecha_publicacion >= ?
              AND c.id NOT IN (SELECT id_contrato FROM ws.ia_matching_results WHERE user_id = ?)
              AND (
                  EXISTS (
                      SELECT 1
                      FROM tmp_profile_cpvs p, unnest(c.cpvs) AS t(cc)
                      WHERE REPLACE(REPLACE(cc::VARCHAR, '.0', ''), ' ', '') LIKE p.prefix || '%'
                  )
                  OR NOT EXISTS (SELECT 1 FROM tmp_profile_cpvs)
              )
              AND (
                  LOWER(c.organismo) IN (SELECT org FROM tmp_profile_orgs)
                  OR NOT EXISTS (SELECT 1 FROM tmp_profile_orgs)
              )
              AND c.importe_licitacion >= ?
              AND c.importe_licitacion <= ?
        ),
        scored AS (
            SELECT
                c.id,
                c.fuente,
                c.organismo,
                c.objeto,
                c.cpv,
                c.importe_licitacion,
                c.fecha_publicacion,
                CASE WHEN EXISTS (
                    SELECT 1
                    FROM tmp_profile_cpvs p, unnest(c.cpvs) AS t(cc)
                    WHERE REPLACE(REPLACE(cc::VARCHAR, '.0', ''), ' ', '') LIKE p.prefix || '%'
                ) THEN ? ELSE 0 END AS score_cpv,
                CASE WHEN LOWER(c.organismo) IN (SELECT org FROM tmp_profile_orgs) THEN ? ELSE 0 END AS score_org,
                CASE WHEN c.importe_licitacion >= ? AND c.importe_licitacion <= ? THEN ? ELSE 0 END AS score_importe,
                CASE WHEN EXISTS (
                    SELECT 1 FROM tmp_profile_sectors s
                    WHERE LOWER(c.objeto) LIKE '%' || s.keyword || '%'
                ) THEN ? ELSE 0 END AS score_sector
            FROM candidatos c
        )
        SELECT
            id,
            fuente,
            organismo,
            objeto,
            cpv,
            importe_licitacion,
            fecha_publicacion,
            score_cpv + score_org + score_importe + score_sector AS score,
            score_cpv, score_org, score_importe, score_sector
        FROM scored
        WHERE score_cpv + score_org + score_importe + score_sector > ?
        ORDER BY score DESC, fecha_publicacion DESC
        LIMIT 100
    """

    params = [
        since,
        user_id,
        float(importe_min) if importe_min and importe_min > 0 else 0.0,
        float(importe_max) if importe_max and importe_max > 0 else 1e18,
        SCORE_CPV,
        SCORE_ORGANISMO,
        float(importe_min) if importe_min and importe_min > 0 else 0.0,
        float(importe_max) if importe_max and importe_max > 0 else 1e18,
        SCORE_IMPORTE,
        SCORE_SECTOR,
        SCORE_MIN,
    ]

    return con_ro.execute(sql, params).fetchall()


def format_importe(val):
    if val is None or val == 0:
        return 'no especificado'
    try:
        n = float(val)
    except (TypeError, ValueError):
        return 'no especificado'
    if n >= 1_000_000:
        return f"€{n/1_000_000:.2f}M"
    if n >= 1_000:
        return f"€{n/1_000:.0f}K"
    return f"€{n:,.0f}"


def build_motivo(contrato, score_cpv, score_org, score_importe, score_sector, profile):
    cpvs = profile[3] or []
    sectores = profile[8] or []
    parts = []
    if score_cpv:
        cpv_contrato = contrato[4] or '—'
        cpv_perfil = ', '.join(cpvs[:3]) or 'tus CPVs'
        parts.append(f"CPV {cpv_contrato} coincide con {cpv_perfil}")
    if score_org:
        parts.append(f"organismo '{contrato[2]}' es de tu lista")
    if score_importe:
        parts.append(f"importe {format_importe(contrato[5])} dentro de tu rango")
    if score_sector:
        sector_hits = [s for s in sectores if s.lower() in str(contrato[3] or '').lower()]
        parts.append(f"objeto contiene keywords: {', '.join(sector_hits[:3])}")

    if not parts:
        return f"Match parcial (score {contrato[7]})."
    return '; '.join(parts).capitalize() + '.'


def insert_matches(con_write, matches):
    now = datetime.utcnow().isoformat()
    inserted = 0
    for m in matches:
        try:
            con_write.execute("""
                INSERT INTO ia_matching_results
                (id_contrato, user_id, score, motivo, fecha_match, enviado_email, fecha_envio)
                VALUES (?, ?, ?, ?, ?, false, NULL)
                ON CONFLICT (id_contrato, user_id) DO UPDATE SET
                    score = EXCLUDED.score,
                    motivo = EXCLUDED.motivo,
                    fecha_match = EXCLUDED.fecha_match,
                    enviado_email = false,
                    fecha_envio = NULL
            """, (m['id_contrato'], m['user_id'], m['score'], m['motivo'], now))
            inserted += 1
        except Exception as e:
            log(f"  🔴 error insertando match {m['id_contrato']}: {e}")
    return inserted


def main():
    dry_run = '--dry-run' in sys.argv
    force_test = '--force-test' in sys.argv

    log('=' * 60)
    log('match-perfiles.py — Matching perfil-contrato')
    log(f'Modo: {"DRY-RUN" if dry_run else "APPLY"}, force_test={force_test}')
    log('=' * 60)

    if not os.path.exists(DB_PATH):
        log(f'🔴 DuckDB no existe: {DB_PATH}')
        sys.exit(1)

    if dry_run:
        con_write = None
    else:
        con_write = get_write_conn()
        con_write.execute("SET memory_limit = '2GB'; SET threads = 2;")

    if force_test and con_write:
        ensure_test_profile(con_write)
        con_write.close()
        # reabrir escritura después de asegurar perfil (copia de solo lectura ya se hizo antes)
        con_write = get_write_conn()
        con_write.execute("SET memory_limit = '2GB'; SET threads = 2;")

    log('Abriendo base de ingesta en solo lectura para matching...')
    con_ro = get_ro_conn()
    con_ro.execute("SET memory_limit = '2GB'; SET threads = 2;")

    perfiles = get_active_profiles(con_ro)
    log(f'{len(perfiles)} perfiles activos encontrados')

    total_matches = 0
    total_inserted = 0

    for perfil in perfiles:
        user_id = perfil[0]
        email = perfil[1] or user_id
        log(f'[PERFIL] {email} (user_id={user_id})')

        rows = find_matches_for_profile(con_ro, perfil)
        if not rows:
            log(f'  0 candidatos relevantes')
            continue

        log(f'  {len(rows)} candidatos con score > {SCORE_MIN}')

        matches = []
        for r in rows:
            contrato = {
                'id': r[0],
                'fuente': r[1],
                'organismo': r[2],
                'objeto': r[3],
                'cpv': r[4],
                'importe_licitacion': r[5],
                'fecha_publicacion': r[6],
            }
            score = int(r[7])
            score_cpv = int(r[8])
            score_org = int(r[9])
            score_importe = int(r[10])
            score_sector = int(r[11])
            motivo = build_motivo(contrato, score_cpv, score_org, score_importe, score_sector, perfil)
            matches.append({
                'id_contrato': r[0],
                'user_id': user_id,
                'score': score,
                'motivo': motivo,
            })

        total_matches += len(matches)

        if dry_run:
            log(f'  [DRY-RUN] no se insertan {len(matches)} matches')
            for m in matches[:5]:
                log(f'    - {m["id_contrato"]} score={m["score"]} | {m["motivo"][:80]}')
            continue

        if con_write:
            inserted = insert_matches(con_write, matches)
            total_inserted += inserted
            log(f'  ✅ insertados {inserted}/{len(matches)} matches')

    con_ro.close()
    if con_write:
        con_write.close()

    log(f'Total: {total_matches} matches calculados, {total_inserted} insertados')
    log('=' * 60)

    if dry_run:
        return {'calculados': total_matches, 'insertados': 0}
    return {'calculados': total_matches, 'insertados': total_inserted}


if __name__ == '__main__':
    try:
        result = main()
        print(json.dumps(result), flush=True)
    except Exception as e:
        log(f'FATAL: {e}')
        raise
