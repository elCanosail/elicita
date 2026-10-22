#!/usr/bin/env python3
"""
profiler_v2.py — Perfilador de empresa usando DuckDB (54.6M registros)
Uso:
  python3 profiler_v2.py B15044357 "Applus"
  python3 profiler_v2.py --cif B15044357 --nombre "Applus"
  python3 profiler_v2.py --cif B15044357  # solo CIF

REGLA ABSOLUTA: CERO datos inventados. Solo datos reales.
Proyecciones derivadas de datos reales etiquetadas [PROYECCIÓN].
"""

import sys
import json
import logging
import argparse
from datetime import datetime, timedelta
from pathlib import Path

import duckdb

# ── Config ────────────────────────────────────────────────────────────────────
DB_PATH = Path("/var/data/licitaciones/db/licitaciones.duckdb")
OUTPUT_PATH = Path("/root/.openclaw/workspace/projects/elicita/ingesta/data/client_profile.json")
OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("profiler_v2")


# ── Helpers ───────────────────────────────────────────────────────────────────

def safe_float(v):
    try:
        f = float(v)
        return f if f == f else None  # NaN check
    except (TypeError, ValueError):
        return None

def safe_str(v):
    if v is None:
        return None
    return str(v).strip() or None

def date_to_str(v):
    if v is None:
        return None
    if hasattr(v, 'isoformat'):
        return v.isoformat()
    return str(v)

def quarter_str(dt):
    """Return 'YYYY-QN' string for a datetime."""
    q = (dt.month - 1) // 3 + 1
    return f"{dt.year}-Q{q}"


# ── Main profiler ─────────────────────────────────────────────────────────────

def build_profile(cif: str, nombre_hint: str = "") -> dict:
    log.info(f"Conectando a DuckDB: {DB_PATH}")
    con = duckdb.connect(str(DB_PATH), read_only=True)

    try:
        return _build_profile(con, cif, nombre_hint)
    finally:
        con.close()


def _build_profile(con, cif: str, nombre_hint: str) -> dict:
    log.info(f"Construyendo perfil para CIF={cif} nombre_hint='{nombre_hint}'")

    # ── 1. Adjudicaciones históricas ─────────────────────────────────────────
    log.info("Consultando adjudicaciones en nacional...")
    nacional_rows = con.execute(f"""
        SELECT
            id, expediente, objeto, organo_contratante, nif_organo, ciudad_organo,
            cpv_principal, cpvs, importe_sin_iva, importe_adjudicacion,
            adjudicatario, nif_adjudicatario, num_ofertas, es_pyme,
            nuts, tipo_contrato, procedimiento, fecha_adjudicacion,
            fecha_publicacion, url, ano
        FROM nacional
        WHERE nif_adjudicatario = '{cif}'
        ORDER BY fecha_adjudicacion DESC NULLS LAST
    """).fetchall()

    nacional_cols = [
        'id', 'expediente', 'objeto', 'organo_contratante', 'nif_organo', 'ciudad_organo',
        'cpv_principal', 'cpvs', 'importe_sin_iva', 'importe_adjudicacion',
        'adjudicatario', 'nif_adjudicatario', 'num_ofertas', 'es_pyme',
        'nuts', 'tipo_contrato', 'procedimiento', 'fecha_adjudicacion',
        'fecha_publicacion', 'url', 'ano'
    ]
    nacional_data = [dict(zip(nacional_cols, r)) for r in nacional_rows]
    for row in nacional_data:
        row['_fuente'] = 'nacional'
    log.info(f"  Nacional: {len(nacional_data)} adjudicaciones")

    log.info("Consultando adjudicaciones en TED...")
    ted_rows = con.execute(f"""
        SELECT
            ID_NOTICE_CAN, CAE_NAME, CAE_NATIONALID, CAE_TOWN, TAL_LOCATION_NUTS,
            TYPE_OF_CONTRACT, CPV, cpv_principal, VALUE_EURO_FIN_1, AWARD_VALUE_EURO_FIN_1,
            importe_adjudicacion, WIN_NAME, WIN_NATIONALID, NUMBER_OFFERS,
            DT_DISPATCH, DT_AWARD, fecha_adjudicacion, ano, organo_contratante, nif_organo
        FROM ted
        WHERE WIN_NATIONALID LIKE '%{cif}%'
        ORDER BY DT_AWARD DESC NULLS LAST
    """).fetchall()

    ted_cols = [
        'id_notice', 'cae_name', 'cae_nationalid', 'cae_town', 'nuts',
        'type_contract', 'cpv_raw', 'cpv_principal', 'value_euro', 'award_value_euro',
        'importe_adjudicacion', 'win_name', 'win_nationalid', 'num_offers',
        'dt_dispatch', 'dt_award', 'fecha_adjudicacion', 'ano', 'organo_contratante', 'nif_organo'
    ]
    ted_data = [dict(zip(ted_cols, r)) for r in ted_rows]
    for row in ted_data:
        row['_fuente'] = 'ted'
    log.info(f"  TED: {len(ted_data)} adjudicaciones")

    # ── Euskadi ──────────────────────────────────────────────────────────────
    log.info("Consultando adjudicaciones en Euskadi...")
    euskadi_data = []
    try:
        eus_rows = con.execute(f"""
            SELECT identificationnumber, adjudicatario, "título", "poder_adjudicador",
                   "importe_de_adjudicación_con_iva", "fecha_de_formalización",
                   "tipo_de_contrato", "código_de_contrato", cpv
            FROM euskadi
            WHERE identificationnumber = '{cif}'
            ORDER BY "fecha_de_formalización" DESC NULLS LAST
        """).fetchall()
        for r in eus_rows:
            fecha = r[5]
            ano = fecha.year if hasattr(fecha, 'year') else None
            euskadi_data.append({
                'id': safe_str(r[7]) or f"EUS-{len(euskadi_data)}",
                'expediente': safe_str(r[7]),
                'objeto': safe_str(r[2]),
                'organo_contratante': safe_str(r[3]),
                'nif_organo': None, 'ciudad_organo': None,
                'cpv_principal': safe_str(r[8]).split(',')[0].strip() if r[8] else None,
                'cpvs': None, 'importe_sin_iva': None,
                'importe_adjudicacion': safe_float(r[4]),
                'adjudicatario': safe_str(r[1]),
                'nif_adjudicatario': cif,
                'num_ofertas': None, 'es_pyme': None, 'nuts': None,
                'tipo_contrato': safe_str(r[6]),
                'procedimiento': None,
                'fecha_adjudicacion': date_to_str(fecha),
                'fecha_publicacion': date_to_str(fecha),
                'url': None, 'ano': ano, '_fuente': 'euskadi',
            })
        log.info(f"  Euskadi: {len(euskadi_data)} adjudicaciones")
    except Exception as e:
        log.warning(f"  Euskadi: error — {e}")

    # ── Madrid (comunidad_madrid) ─────────────────────────────────────────
    log.info("Consultando adjudicaciones en Madrid...")
    madrid_data = []
    try:
        mad_rows = con.execute(f"""
            SELECT "NIF del adjudicatario", "Adjudicatario", "Título del contrato",
                   "Entidad Adjudicadora", "Importe de adjudicación", "Fecha del contrato",
                   "Tipo de contrato", "Nº Expediente", "Nº de ofertas"
            FROM comunidad_madrid
            WHERE "NIF del adjudicatario" = '{cif}'
            ORDER BY "Fecha del contrato" DESC NULLS LAST
        """).fetchall()
        for r in mad_rows:
            fecha = r[5]
            ano = fecha.year if hasattr(fecha, 'year') else None
            madrid_data.append({
                'id': safe_str(r[7]) or f"MAD-{len(madrid_data)}",
                'expediente': safe_str(r[7]),
                'objeto': safe_str(r[2]),
                'organo_contratante': safe_str(r[3]),
                'nif_organo': None, 'ciudad_organo': None,
                'cpv_principal': None, 'cpvs': None, 'importe_sin_iva': None,
                'importe_adjudicacion': safe_float(r[4]),
                'adjudicatario': safe_str(r[1]),
                'nif_adjudicatario': cif,
                'num_ofertas': safe_float(r[8]),
                'es_pyme': None, 'nuts': None,
                'tipo_contrato': safe_str(r[6]),
                'procedimiento': None,
                'fecha_adjudicacion': date_to_str(fecha),
                'fecha_publicacion': date_to_str(fecha),
                'url': None, 'ano': ano, '_fuente': 'madrid',
            })
        log.info(f"  Madrid: {len(madrid_data)} adjudicaciones")
    except Exception as e:
        log.warning(f"  Madrid: error — {e}")

    # ── Galicia ──────────────────────────────────────────────────────────────
    log.info("Consultando adjudicaciones en Galicia...")
    galicia_data = []
    try:
        galicia_rows = con.execute(f"""
            SELECT id, objeto, importe, estado, publicado, nif, adjudicatario, duracion
            FROM galicia
            WHERE nif = '{cif}'
        """).fetchall()
        for r in galicia_rows:
            pub = r[4]
            galicia_data.append({
                'id': safe_str(r[0]),
                'expediente': None,
                'objeto': safe_str(r[1]),
                'organo_contratante': None,
                'nif_organo': None,
                'ciudad_organo': None,
                'cpv_principal': None,
                'cpvs': None,
                'importe_sin_iva': None,
                'importe_adjudicacion': safe_float(r[2]),
                'adjudicatario': safe_str(r[6]),
                'nif_adjudicatario': cif,
                'num_ofertas': None,
                'es_pyme': None,
                'nuts': None,
                'tipo_contrato': None,
                'procedimiento': None,
                'fecha_adjudicacion': None,
                'fecha_publicacion': date_to_str(pub),
                'url': None,
                'ano': pub.year if hasattr(pub, 'year') else (int(str(pub)[:4]) if pub and str(pub)[:4].isdigit() else None),
                '_fuente': 'galicia',
            })
        log.info(f"  Galicia: {len(galicia_data)} adjudicaciones")
    except Exception as e:
        log.warning(f"  Galicia query falló: {e}")

    # ── Andalucía ────────────────────────────────────────────────────────────
    log.info("Consultando adjudicaciones en Andalucía...")
    andalucia_data = []
    try:
        andalucia_rows = con.execute(f"""
            SELECT id_expediente, numero_expediente, titulo, organo_contratacion, estado,
                   importe_adjudicacion, adjudicatario_nif, cpv, fecha_publicacion, url_detalle,
                   tipo_contrato
            FROM andalucia
            WHERE adjudicatario_nif LIKE '%{cif}%'
        """).fetchall()
        for r in andalucia_rows:
            cpv_raw = safe_str(r[7])
            cpv_first = cpv_raw.split(',')[0].strip() if cpv_raw else None
            pub = r[8]
            pub_str = date_to_str(pub)
            ano = pub.year if hasattr(pub, 'year') else (int(str(pub)[:4]) if pub and str(pub)[:4].isdigit() else None)
            andalucia_data.append({
                'id': safe_str(r[0]),
                'expediente': safe_str(r[1]),
                'objeto': safe_str(r[2]),
                'organo_contratante': safe_str(r[3]),
                'nif_organo': None,
                'ciudad_organo': None,
                'cpv_principal': cpv_first,
                'cpvs': None,
                'importe_sin_iva': None,
                'importe_adjudicacion': safe_float(r[5]),
                'adjudicatario': None,
                'nif_adjudicatario': safe_str(r[6]) or cif,
                'num_ofertas': None,
                'es_pyme': None,
                'nuts': None,
                'tipo_contrato': safe_str(r[10]),
                'procedimiento': None,
                'fecha_adjudicacion': None,
                'fecha_publicacion': pub_str,
                'url': safe_str(r[9]),
                'ano': ano,
                '_fuente': 'andalucia',
            })
        log.info(f"  Andalucía: {len(andalucia_data)} adjudicaciones")
    except Exception as e:
        log.warning(f"  Andalucía query falló: {e}")

    # ── Catalunya ────────────────────────────────────────────────────────────
    log.info("Consultando adjudicaciones en Catalunya...")
    catalunya_data = []
    try:
        catalunya_rows = con.execute(f"""
            SELECT IDENTIFICACIO_ADJUDICATARI, DENOMINACIO_ADJUDICATARI,
                   OBJECTE_CONTRACTE, NOM_ORGAN, CODI_CPV,
                   IMPORT_ADJUDICACIO_SENSE_IVA, DATA_ADJUDICACIO_CONTRACTE,
                   DATA_PUBLICACIO_ANUNCI, TIPUS_CONTRACTE, CODI_EXPEDIENT,
                   ENLLAC_PUBLICACIO
            FROM catalunya
            WHERE "NIF" = '{cif}' OR "NIF adjudicatari" = '{cif}' OR IDENTIFICACIO_ADJUDICATARI = '{cif}'
        """).fetchall()
        for r in catalunya_rows:
            adj_date = r[6]
            pub_date = r[7]
            adj_date_str = date_to_str(adj_date)
            pub_date_str = date_to_str(pub_date)
            # Determine year from adjudicacion or publicacion
            ano = None
            for d in [adj_date, pub_date]:
                if d is not None:
                    if hasattr(d, 'year'):
                        ano = d.year
                    elif str(d)[:4].isdigit():
                        ano = int(str(d)[:4])
                    if ano:
                        break
            catalunya_data.append({
                'id': safe_str(r[9]),
                'expediente': safe_str(r[9]),
                'objeto': safe_str(r[2]),
                'organo_contratante': safe_str(r[3]),
                'nif_organo': None,
                'ciudad_organo': None,
                'cpv_principal': safe_str(r[4]),
                'cpvs': None,
                'importe_sin_iva': None,
                'importe_adjudicacion': safe_float(r[5]),
                'adjudicatario': safe_str(r[1]),
                'nif_adjudicatario': safe_str(r[0]) or cif,
                'num_ofertas': None,
                'es_pyme': None,
                'nuts': None,
                'tipo_contrato': safe_str(r[8]),
                'procedimiento': None,
                'fecha_adjudicacion': adj_date_str,
                'fecha_publicacion': pub_date_str,
                'url': safe_str(r[10]),
                'ano': ano,
                '_fuente': 'catalunya',
            })
        log.info(f"  Catalunya: {len(catalunya_data)} adjudicaciones")
    except Exception as e:
        log.warning(f"  Catalunya query falló: {e}")

    # ── TED normalization (for all_data compatibility) ───────────────────────
    ted_normalized = []
    for r in ted_data:
        ted_normalized.append({
            'id': safe_str(r.get('id_notice')),
            'expediente': None,
            'objeto': None,
            'organo_contratante': safe_str(r.get('cae_name')) or safe_str(r.get('organo_contratante')),
            'nif_organo': safe_str(r.get('nif_organo')),
            'ciudad_organo': safe_str(r.get('cae_town')),
            'cpv_principal': safe_str(r.get('cpv_principal')) or safe_str(r.get('cpv_raw')),
            'cpvs': None,
            'importe_sin_iva': safe_float(r.get('value_euro')),
            'importe_adjudicacion': safe_float(r.get('importe_adjudicacion')) or safe_float(r.get('award_value_euro')),
            'adjudicatario': safe_str(r.get('win_name')),
            'nif_adjudicatario': safe_str(r.get('win_nationalid')),
            'num_ofertas': safe_float(r.get('num_offers')),
            'es_pyme': None,
            'nuts': safe_str(r.get('nuts')),
            'tipo_contrato': safe_str(r.get('type_contract')),
            'procedimiento': None,
            'fecha_adjudicacion': date_to_str(r.get('fecha_adjudicacion')) or safe_str(r.get('dt_award')),
            'fecha_publicacion': safe_str(r.get('dt_dispatch')),
            'url': None,
            'ano': r.get('ano'),
            '_fuente': 'ted',
        })

    # ── Combine all sources ───────────────────────────────────────────────────
    all_data = nacional_data + ted_normalized + euskadi_data + madrid_data + galicia_data + andalucia_data + catalunya_data
    log.info(f"  Total combinado: {len(all_data)} adjudicaciones")

    # Nombre de empresa desde datos reales
    empresa_nombre = nombre_hint
    if not empresa_nombre and nacional_data:
        empresa_nombre = safe_str(nacional_data[0].get('adjudicatario')) or ""
    if not empresa_nombre and ted_data:
        empresa_nombre = safe_str(ted_data[0].get('win_name')) or ""
    if not empresa_nombre:
        for row in all_data:
            n = safe_str(row.get('adjudicatario'))
            if n:
                empresa_nombre = n
                break

    # ── 2. CPVs activos ──────────────────────────────────────────────────────
    log.info("Calculando CPVs activos...")
    cpv_counter = {}
    cpv_volume = {}
    for row in all_data:
        cpv = safe_str(row['cpv_principal'])
        if not cpv:
            continue
        imp = safe_float(row['importe_adjudicacion']) or 0
        cpv_counter[cpv] = cpv_counter.get(cpv, 0) + 1
        cpv_volume[cpv] = cpv_volume.get(cpv, 0) + imp

    cpvs_activos = sorted(
        [{'cpv': k, 'contratos': v, 'volumen': round(cpv_volume[k], 2)}
         for k, v in cpv_counter.items()],
        key=lambda x: x['contratos'], reverse=True
    )
    top_cpvs = [c['cpv'] for c in cpvs_activos[:20]]
    log.info(f"  CPVs distintos: {len(cpvs_activos)}")

    # ── 3. Organismos recurrentes ────────────────────────────────────────────
    log.info("Calculando organismos recurrentes...")
    org_data = {}
    for row in all_data:
        org = safe_str(row['organo_contratante']) or 'DESCONOCIDO'
        nif_org = safe_str(row['nif_organo'])
        imp = safe_float(row['importe_adjudicacion']) or 0
        fecha_raw = row.get('fecha_adjudicacion') or row.get('fecha_publicacion')
        # Normalize fecha to string for comparison
        fecha_str = date_to_str(fecha_raw) if fecha_raw else None
        key = nif_org or org
        if key not in org_data:
            org_data[key] = {'nombre': org, 'nif': nif_org, 'contratos': 0, 'volumen': 0.0, 'ultimo': None}
        org_data[key]['contratos'] += 1
        org_data[key]['volumen'] += imp
        if fecha_str and (org_data[key]['ultimo'] is None or fecha_str > org_data[key]['ultimo']):
            org_data[key]['ultimo'] = fecha_str

    organismos = sorted(
        [{'nombre': v['nombre'], 'nif': v['nif'],
          'contratos': v['contratos'], 'volumen': round(v['volumen'], 2),
          'ultimo': v['ultimo']}  # already normalized to str
         for v in org_data.values()],
        key=lambda x: x['contratos'], reverse=True
    )
    log.info(f"  Organismos distintos: {len(organismos)}")

    # ── 4. Importes por CPV (estadísticas) ───────────────────────────────────
    log.info("Calculando estadísticas de importes por CPV...")
    if top_cpvs:
        cpv_list_sql = "', '".join(top_cpvs)
        cpv_stats_rows = con.execute(f"""
            SELECT
                cpv_principal,
                COUNT(*) as contratos,
                AVG(importe_adjudicacion) as media,
                MEDIAN(importe_adjudicacion) as mediana,
                MAX(importe_adjudicacion) as maximo,
                MIN(importe_adjudicacion) as minimo,
                SUM(importe_adjudicacion) as total
            FROM nacional
            WHERE nif_adjudicatario = '{cif}'
              AND cpv_principal IN ('{cpv_list_sql}')
              AND importe_adjudicacion > 0
            GROUP BY cpv_principal
            ORDER BY contratos DESC
        """).fetchall()

        cpv_stats = {}
        for r in cpv_stats_rows:
            cpv_stats[safe_str(r[0])] = {
                'contratos': r[1],
                'media': round(r[2], 2) if r[2] else None,
                'mediana': round(r[3], 2) if r[3] else None,
                'maximo': round(r[4], 2) if r[4] else None,
                'minimo': round(r[5], 2) if r[5] else None,
                'total': round(r[6], 2) if r[6] else None,
            }

        # Add CCAA data into cpv_stats (python aggregation for non-nacional sources)
        ccaa_cpv_importes = {}
        for row in ted_normalized + euskadi_data + madrid_data + galicia_data + andalucia_data + catalunya_data:
            cpv = safe_str(row.get('cpv_principal'))
            imp = safe_float(row.get('importe_adjudicacion'))
            if cpv and imp and imp > 0:
                ccaa_cpv_importes.setdefault(cpv, []).append(imp)

        for cpv, imps in ccaa_cpv_importes.items():
            if cpv not in cpv_stats:
                cpv_stats[cpv] = {'contratos': 0, 'media': None, 'mediana': None, 'maximo': None, 'minimo': None, 'total': None}
            existing = cpv_stats[cpv]
            all_imps = imps
            # merge with existing nacional imps if available
            if existing.get('total') and existing.get('contratos'):
                # approximate: we can't recover individual values, just supplement totals
                combined_total = (existing['total'] or 0) + sum(imps)
                combined_count = existing['contratos'] + len(imps)
                existing['contratos'] = combined_count
                existing['total'] = round(combined_total, 2)
                existing['media'] = round(combined_total / combined_count, 2)
            else:
                existing['contratos'] = existing.get('contratos', 0) + len(imps)
                existing['total'] = round(sum(all_imps), 2)
                existing['media'] = round(sum(all_imps) / len(all_imps), 2)
                existing['maximo'] = round(max(all_imps), 2)
                existing['minimo'] = round(min(all_imps), 2)

        # Merge into cpvs_activos
        for entry in cpvs_activos:
            stats = cpv_stats.get(entry['cpv'], {})
            entry.update({
                'importe_medio': stats.get('media'),
                'importe_mediana': stats.get('mediana'),
                'importe_max': stats.get('maximo'),
            })

    # ── 5. Distribución geográfica ───────────────────────────────────────────
    log.info("Calculando distribución geográfica...")
    geo_rows = con.execute(f"""
        SELECT nuts, ciudad_organo, COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
        FROM nacional
        WHERE nif_adjudicatario = '{cif}'
          AND nuts IS NOT NULL
        GROUP BY nuts, ciudad_organo
        ORDER BY contratos DESC
        LIMIT 30
    """).fetchall()

    distribucion_geografica = [
        {'nuts': safe_str(r[0]), 'ciudad': safe_str(r[1]),
         'contratos': r[2], 'volumen': round(r[3], 2) if r[3] else None}
        for r in geo_rows
    ]

    # ── 6. Evolución temporal ────────────────────────────────────────────────
    log.info("Calculando evolución temporal...")
    evol_rows = con.execute(f"""
        SELECT ano, COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
        FROM nacional
        WHERE nif_adjudicatario = '{cif}'
          AND ano IS NOT NULL AND ano > 2000
        GROUP BY ano
        ORDER BY ano
    """).fetchall()

    evol_by_ano = {}
    for r in evol_rows:
        evol_by_ano[int(r[0])] = {'contratos': r[1], 'volumen': float(r[2]) if r[2] else 0.0}

    # Supplement with CCAA data
    for row in ted_normalized + euskadi_data + madrid_data + galicia_data + andalucia_data + catalunya_data:
        ano_raw = row.get('ano')
        if ano_raw is None:
            # Try extracting year from fecha_adjudicacion or fecha_publicacion
            for date_field in ['fecha_adjudicacion', 'fecha_publicacion']:
                d = row.get(date_field)
                if d and str(d)[:4].isdigit():
                    try:
                        ano_raw = int(str(d)[:4])
                        break
                    except ValueError:
                        pass
        if ano_raw is None:
            continue
        try:
            ano = int(ano_raw)
        except (ValueError, TypeError):
            continue
        if ano <= 2000 or ano > 2100:
            continue
        imp = safe_float(row.get('importe_adjudicacion')) or 0.0
        if ano not in evol_by_ano:
            evol_by_ano[ano] = {'contratos': 0, 'volumen': 0.0}
        evol_by_ano[ano]['contratos'] += 1
        evol_by_ano[ano]['volumen'] += imp

    evolucion_anual = [
        {'ano': ano, 'contratos': v['contratos'], 'volumen': round(v['volumen'], 2)}
        for ano, v in sorted(evol_by_ano.items())
    ]

    # ── 7. Competidores reales ────────────────────────────────────────────────
    log.info("Buscando competidores reales...")
    competidores = []
    if top_cpvs:
        cpv_list_sql = "', '".join(top_cpvs)
        comp_rows = con.execute(f"""
            SELECT
                adjudicatario,
                nif_adjudicatario,
                COUNT(*) as adjudicaciones,
                SUM(importe_adjudicacion) as volumen,
                array_agg(DISTINCT cpv_principal) as cpvs_ganados
            FROM nacional
            WHERE cpv_principal IN ('{cpv_list_sql}')
              AND nif_adjudicatario != '{cif}'
              AND nif_adjudicatario IS NOT NULL
              AND nif_adjudicatario != ''
              AND adjudicatario IS NOT NULL
            GROUP BY adjudicatario, nif_adjudicatario
            ORDER BY adjudicaciones DESC
            LIMIT 30
        """).fetchall()

        # For each competitor, find common CPVs with our client
        client_cpvs_set = set(top_cpvs)
        for r in comp_rows:
            comp_cpvs_raw = r[4]  # array from duckdb
            if isinstance(comp_cpvs_raw, (list, tuple)):
                comp_cpvs = [safe_str(c) for c in comp_cpvs_raw if c]
            else:
                comp_cpvs = []
            cpvs_comunes = [c for c in comp_cpvs if c in client_cpvs_set]
            competidores.append({
                'nombre': safe_str(r[0]),
                'nif': safe_str(r[1]),
                'adjudicaciones': r[2],
                'volumen': round(r[3], 2) if r[3] else None,
                'cpvs_comunes': cpvs_comunes[:10],
            })
    log.info(f"  Competidores encontrados: {len(competidores)}")

    # ── 8. Ciclos de renovación ──────────────────────────────────────────────
    log.info("Calculando ciclos de renovación...")
    ciclo_rows = con.execute(f"""
        SELECT organo_contratante, nif_organo, cpv_principal, fecha_adjudicacion
        FROM nacional
        WHERE nif_adjudicatario = '{cif}'
          AND organo_contratante IS NOT NULL
          AND cpv_principal IS NOT NULL
          AND fecha_adjudicacion IS NOT NULL
        ORDER BY organo_contratante, cpv_principal, fecha_adjudicacion
    """).fetchall()

    # Group by (org, cpv) and compute intervals
    from collections import defaultdict
    grupos = defaultdict(list)
    for r in ciclo_rows:
        key = (safe_str(r[0]), safe_str(r[1]), safe_str(r[2]))
        if r[3]:
            grupos[key].append(r[3])

    # Supplement with CCAA data (all_data minus nacional)
    for row in ted_normalized + euskadi_data + madrid_data + galicia_data + andalucia_data + catalunya_data:
        org = safe_str(row.get('organo_contratante'))
        nif_org = safe_str(row.get('nif_organo'))
        cpv = safe_str(row.get('cpv_principal'))
        if not org or not cpv:
            continue
        fecha_raw = row.get('fecha_adjudicacion') or row.get('fecha_publicacion')
        if not fecha_raw:
            continue
        # Parse to datetime if string
        if isinstance(fecha_raw, str):
            try:
                fecha = datetime.fromisoformat(fecha_raw[:10])
            except ValueError:
                continue
        elif hasattr(fecha_raw, 'year'):
            fecha = fecha_raw
        else:
            continue
        key = (org, nif_org, cpv)
        grupos[key].append(fecha)

    ciclos_renovacion = []
    hoy = datetime.now()
    for (org, nif_org, cpv), fechas in grupos.items():
        if len(fechas) < 2:
            continue
        # Sort and compute intervals in days
        fechas_sorted = sorted(fechas)
        intervalos_dias = []
        for i in range(1, len(fechas_sorted)):
            try:
                d0 = fechas_sorted[i-1]
                d1 = fechas_sorted[i]
                if hasattr(d0, 'days'):
                    # timedelta
                    diff = (d1 - d0).days
                else:
                    # datetime-like
                    diff = (d1 - d0).days
                if 30 <= diff <= 3650:  # sanity: 1 month to 10 years
                    intervalos_dias.append(diff)
            except Exception:
                pass

        if not intervalos_dias:
            continue

        avg_dias = sum(intervalos_dias) / len(intervalos_dias)
        avg_meses = round(avg_dias / 30.44, 1)
        ultima_fecha = fechas_sorted[-1]

        # Project next renewal [PROYECCIÓN]
        try:
            if hasattr(ultima_fecha, 'timestamp'):
                proximo_dt = ultima_fecha + timedelta(days=avg_dias)
            else:
                proximo_dt = ultima_fecha + timedelta(days=avg_dias)
            proximo = f"[PROYECCIÓN] {quarter_str(proximo_dt)}"
        except Exception:
            proximo = None

        # Confidence based on sample size
        n = len(intervalos_dias)
        confianza = "alta" if n >= 4 else ("media" if n >= 2 else "baja")

        ciclos_renovacion.append({
            'organismo': org,
            'nif_organo': nif_org,
            'cpv': cpv,
            'num_contratos': len(fechas),
            'intervalo_medio_meses': avg_meses,
            'ultima_adjudicacion': date_to_str(ultima_fecha),
            'proximo_estimado': proximo,
            'confianza': confianza,
        })

    # Sort by confianza and num_contratos
    orden_confianza = {'alta': 0, 'media': 1, 'baja': 2}
    ciclos_renovacion.sort(key=lambda x: (orden_confianza[x['confianza']], -x['num_contratos']))
    log.info(f"  Ciclos de renovación detectados: {len(ciclos_renovacion)}")

    # ── 9. Estacionalidad ────────────────────────────────────────────────────
    log.info("Calculando estacionalidad...")

    # Global monthly distribution from all_data (Python-side, reuse all_data)
    month_global = {}
    for row in all_data:
        for df in ['fecha_adjudicacion', 'fecha_publicacion']:
            fecha_raw = row.get(df)
            if not fecha_raw:
                continue
            try:
                if hasattr(fecha_raw, 'month'):
                    mes = fecha_raw.month
                else:
                    mes = datetime.fromisoformat(str(fecha_raw)[:10]).month
                month_global[mes] = month_global.get(mes, 0) + 1
                break  # use first valid date field
            except Exception:
                pass

    estacionalidad_global = {str(m): month_global.get(m, 0) for m in range(1, 13)}

    # Per (org, cpv) month distribution — SQL query from nacional
    estac_dict = {}  # (org, cpv) -> {month: count}
    if top_cpvs:
        cpv_list_sql = "', '".join(top_cpvs)
        estac_rows = con.execute(f"""
            SELECT
                organo_contratante,
                cpv_principal,
                CAST(EXTRACT(month FROM fecha_adjudicacion) AS INTEGER) AS mes,
                COUNT(*) AS cnt
            FROM nacional
            WHERE nif_adjudicatario = '{cif}'
              AND cpv_principal IN ('{cpv_list_sql}')
              AND fecha_adjudicacion IS NOT NULL
            GROUP BY organo_contratante, cpv_principal, mes
            ORDER BY organo_contratante, cpv_principal, mes
        """).fetchall()

        for r in estac_rows:
            org_k = safe_str(r[0])
            cpv_k = safe_str(r[1])
            mes = int(r[2]) if r[2] is not None else None
            cnt = int(r[3]) if r[3] else 0
            if org_k and cpv_k and mes:
                estac_dict.setdefault((org_k, cpv_k), {})[mes] = cnt

    # Enrich ciclos_renovacion items with meses_pico and mes_tipico
    for ciclo in ciclos_renovacion:
        org_c = ciclo['organismo']
        cpv_c = ciclo['cpv']
        dist = estac_dict.get((org_c, cpv_c), {})
        if dist:
            max_cnt = max(dist.values())
            meses_pico = sorted(m for m, c in dist.items() if c == max_cnt)
            mes_tipico = meses_pico[0] if meses_pico else None
        else:
            meses_pico = []
            mes_tipico = None
        ciclo['meses_pico'] = meses_pico
        ciclo['mes_tipico'] = mes_tipico

    log.info(f"  Estacionalidad global: {sum(month_global.values())} contratos con fecha; "
             f"{len(estac_dict)} pares (org, CPV) con datos de mes")

    # ── 10. Tendencia de gasto ───────────────────────────────────────────────
    log.info("Calculando tendencia de gasto...")
    tendencia_gasto = []
    tend_lookup = {}  # (org, cpv) -> tendencia str, for enriching ciclos

    if top_cpvs:
        cpv_list_sql = "', '".join(top_cpvs)
        tend_rows = con.execute(f"""
            SELECT organo_contratante, cpv_principal,
                   CAST(ano AS INTEGER) AS ano,
                   SUM(importe_adjudicacion) AS vol_ano
            FROM nacional
            WHERE nif_adjudicatario = '{cif}'
              AND cpv_principal IN ('{cpv_list_sql}')
              AND ano IS NOT NULL AND ano > 2000
              AND importe_adjudicacion > 0
            GROUP BY organo_contratante, cpv_principal, ano
            ORDER BY organo_contratante, cpv_principal, ano
        """).fetchall()

        # Group by (org, cpv)
        tend_dict: dict = {}
        for r in tend_rows:
            org_k = safe_str(r[0])
            cpv_k = safe_str(r[1])
            ano_k = int(r[2]) if r[2] else None
            vol = float(r[3]) if r[3] else 0.0
            if org_k and cpv_k and ano_k:
                tend_dict.setdefault((org_k, cpv_k), []).append((ano_k, vol))

        for (org, cpv), ano_vol_list in tend_dict.items():
            if len(ano_vol_list) < 3:
                continue
            anos = [x[0] for x in ano_vol_list]
            vols = [x[1] for x in ano_vol_list]
            n = len(anos)
            mean_ano = sum(anos) / n
            mean_vol = sum(vols) / n
            # OLS slope: Σ((x-x̄)(y-ȳ)) / Σ((x-x̄)²)
            num = sum((anos[i] - mean_ano) * (vols[i] - mean_vol) for i in range(n))
            den = sum((anos[i] - mean_ano) ** 2 for i in range(n))
            slope = num / den if den != 0 else 0.0
            # Classify vs 5% of mean annual volume
            variacion_pct = round(slope / mean_vol * 100, 1) if mean_vol > 0 else 0.0
            if variacion_pct > 5:
                tendencia = "creciente"
            elif variacion_pct < -5:
                tendencia = "decreciente"
            else:
                tendencia = "estable"

            tendencia_gasto.append({
                'organismo': org,
                'cpv': cpv,
                'años_datos': n,
                'importe_medio_anual': round(mean_vol, 2),
                'tendencia': tendencia,
                'variacion_pct': variacion_pct,
            })
            tend_lookup[(org, cpv)] = tendencia

        # Enrich ciclos_renovacion with tendencia field
        for ciclo in ciclos_renovacion:
            key = (ciclo['organismo'], ciclo['cpv'])
            ciclo['tendencia'] = tend_lookup.get(key)

    log.info(f"  Tendencia de gasto: {len(tendencia_gasto)} pares (org, CPV) con ≥3 años de datos")

    # ── 11. Oportunidades no incumbente + probabilidad de entrada ────────────
    log.info("Calculando oportunidades no incumbente...")
    oportunidades_no_incumbente = []

    if top_cpvs:
        cpv_list_sql = "', '".join(top_cpvs)

        # Organismos where company has NOT won (excluding known orgs)
        opor_rows = con.execute(f"""
            WITH mis_orgs AS (
                SELECT DISTINCT organo_contratante
                FROM nacional
                WHERE nif_adjudicatario = '{cif}'
                  AND organo_contratante IS NOT NULL
            )
            SELECT
                n.organo_contratante,
                n.cpv_principal,
                COUNT(*)                                            AS num_contratos,
                SUM(n.importe_adjudicacion)                        AS volumen_eur,
                MAX(n.ano)                                         AS ultimo_ano,
                COUNT(DISTINCT n.nif_adjudicatario)                AS adj_distintos,
                AVG(TRY_CAST(n.num_ofertas AS DOUBLE))             AS avg_ofertas
            FROM nacional n
            WHERE n.cpv_principal IN ('{cpv_list_sql}')
              AND n.organo_contratante NOT IN (SELECT organo_contratante FROM mis_orgs)
              AND n.organo_contratante IS NOT NULL
              AND n.importe_adjudicacion > 0
            GROUP BY n.organo_contratante, n.cpv_principal
            ORDER BY volumen_eur DESC NULLS LAST
            LIMIT 50
        """).fetchall()

        # Compute rotation rate for the top-50 orgs via window function
        rot_dict: dict = {}
        orgs_opor = list({safe_str(r[0]) for r in opor_rows if r[0]})
        if orgs_opor:
            # Limit org list to first 80 to keep query fast
            orgs_sql = "', '".join(orgs_opor[:80])
            rot_rows = con.execute(f"""
                WITH ranked AS (
                    SELECT
                        organo_contratante,
                        cpv_principal,
                        nif_adjudicatario,
                        LAG(nif_adjudicatario) OVER (
                            PARTITION BY organo_contratante, cpv_principal
                            ORDER BY fecha_adjudicacion
                        ) AS prev_adj
                    FROM nacional
                    WHERE cpv_principal IN ('{cpv_list_sql}')
                      AND organo_contratante IN ('{orgs_sql}')
                      AND nif_adjudicatario IS NOT NULL
                      AND fecha_adjudicacion IS NOT NULL
                )
                SELECT
                    organo_contratante,
                    cpv_principal,
                    COUNT(*) AS total,
                    SUM(CASE WHEN prev_adj IS NOT NULL
                             AND nif_adjudicatario != prev_adj THEN 1 ELSE 0 END) AS rotaciones
                FROM ranked
                GROUP BY organo_contratante, cpv_principal
            """).fetchall()

            for r in rot_rows:
                org_k = safe_str(r[0])
                cpv_k = safe_str(r[1])
                total = int(r[2]) if r[2] else 0
                rots = int(r[3]) if r[3] else 0
                tasa = round(rots / (total - 1) * 100, 1) if total > 1 else 0.0
                rot_dict[(org_k, cpv_k)] = tasa

        for r in opor_rows:
            org = safe_str(r[0])
            cpv = safe_str(r[1])
            num_contratos = int(r[2]) if r[2] else 0
            volumen = float(r[3]) if r[3] else 0.0
            ultimo_ano = int(r[4]) if r[4] else None
            adj_distintos = int(r[5]) if r[5] else 0
            avg_ofertas = float(r[6]) if r[6] else 0.0
            tasa_rotacion = rot_dict.get((org, cpv), 0.0)

            # Probability score: sum of signals
            score = 0
            if adj_distintos >= 3:
                score += 1
            if avg_ofertas >= 3:
                score += 1
            if tasa_rotacion >= 40:
                score += 1

            if score >= 2:
                prob_entrada = "alta"
            elif score == 1:
                prob_entrada = "media"
            else:
                prob_entrada = "baja"

            oportunidades_no_incumbente.append({
                'organismo': org,
                'cpv': cpv,
                'num_contratos': num_contratos,
                'volumen_eur': round(volumen, 2),
                'ultimo_ano': ultimo_ano,
                'prob_entrada': prob_entrada,
                'adjudicatarios_distintos': adj_distintos,
                'num_ofertas_medio': round(avg_ofertas, 1) if avg_ofertas else None,
                'tasa_rotacion_pct': tasa_rotacion,
            })

    log.info(f"  Oportunidades no incumbente: {len(oportunidades_no_incumbente)}")

    # ── 12. Score de compatibilidad ──────────────────────────────────────────
    log.info("Calculando score de compatibilidad por organismo...")
    organismos_compatibles = []

    if top_cpvs:
        cpv_list_sql = "', '".join(top_cpvs)

        # Company CPV volume profile (already in cpvs_activos)
        company_vol = {c['cpv']: c['volumen'] for c in cpvs_activos if c.get('cpv') in set(top_cpvs) and c.get('volumen', 0) > 0}
        comp_norm = sum(v ** 2 for v in company_vol.values()) ** 0.5

        # Org CPV profiles restricted to company's top CPVs — fast and focused
        compat_rows = con.execute(f"""
            SELECT organo_contratante, cpv_principal, SUM(importe_adjudicacion) AS vol
            FROM nacional
            WHERE cpv_principal IN ('{cpv_list_sql}')
              AND organo_contratante IS NOT NULL
              AND importe_adjudicacion > 0
            GROUP BY organo_contratante, cpv_principal
        """).fetchall()

        # Build org profiles: {org: {total_vol, cpvs: {cpv: vol}}}
        org_profiles: dict = {}
        for r in compat_rows:
            org_k = safe_str(r[0])
            cpv_k = safe_str(r[1])
            vol = float(r[2]) if r[2] else 0.0
            if org_k and cpv_k:
                if org_k not in org_profiles:
                    org_profiles[org_k] = {'total_vol': 0.0, 'cpvs': {}}
                org_profiles[org_k]['total_vol'] += vol
                org_profiles[org_k]['cpvs'][cpv_k] = vol

        # Cosine similarity
        scores = []
        for org, prof in org_profiles.items():
            org_cpvs = prof['cpvs']
            dot = sum(company_vol.get(cpv, 0) * org_cpvs.get(cpv, 0) for cpv in company_vol)
            org_norm = sum(v ** 2 for v in org_cpvs.values()) ** 0.5
            if comp_norm > 0 and org_norm > 0:
                cos_sim = dot / (comp_norm * org_norm)
                score_100 = round(min(cos_sim * 100, 100.0), 1)
            else:
                score_100 = 0.0
            cpvs_comunes = [cpv for cpv in company_vol if cpv in org_cpvs]
            scores.append({
                'organismo': org,
                'score': score_100,
                'cpvs_comunes': cpvs_comunes,
                'volumen_total': round(prof['total_vol'], 2),
            })

        scores.sort(key=lambda x: x['score'], reverse=True)
        organismos_compatibles = scores[:30]

    log.info(f"  Organismos compatibles: {len(organismos_compatibles)}")

    # ── 13. Bajas ganadoras (benchmark) ──────────────────────────────────────
    log.info("Calculando bajas ganadoras...")
    bajas = []
    if top_cpvs:
        cpv_list_sql = "', '".join(top_cpvs)
        baja_rows = con.execute(f"""
            SELECT
                cpv_principal,
                COUNT(*) as muestras,
                AVG((importe_sin_iva - importe_adjudicacion) / NULLIF(importe_sin_iva, 0) * 100) as baja_media,
                MIN((importe_sin_iva - importe_adjudicacion) / NULLIF(importe_sin_iva, 0) * 100) as baja_min,
                MAX((importe_sin_iva - importe_adjudicacion) / NULLIF(importe_sin_iva, 0) * 100) as baja_max
            FROM nacional
            WHERE importe_sin_iva > 0
              AND importe_adjudicacion > 0
              AND importe_adjudicacion <= importe_sin_iva * 1.1
              AND cpv_principal IN ('{cpv_list_sql}')
            GROUP BY cpv_principal
            HAVING COUNT(*) >= 3
            ORDER BY muestras DESC
            LIMIT 30
        """).fetchall()

        for r in baja_rows:
            bajas.append({
                'cpv': safe_str(r[0]),
                'muestras': r[1],
                'baja_media_pct': round(r[2], 2) if r[2] else None,
                'baja_min_pct': round(r[3], 2) if r[3] else None,
                'baja_max_pct': round(r[4], 2) if r[4] else None,
            })
    log.info(f"  Bajas ganadoras calculadas para {len(bajas)} CPVs")

    # ── 10. BORME ─────────────────────────────────────────────────────────────
    log.info("Consultando BORME...")
    borme = {'empresas_relacionadas': [], 'cargos': []}

    # Search by nombre_hint words (≥4 chars)
    palabras = [p for p in (nombre_hint or empresa_nombre or '').split() if len(p) >= 4]
    if palabras:
        for palabra in palabras[:3]:  # max 3 palabras
            borme_emp_rows = con.execute(f"""
                SELECT empresa, provincia, domicilio, capital_euros, fecha_constitucion,
                       hoja_registral, fecha_borme
                FROM borme_empresas
                WHERE empresa LIKE '%{palabra}%'
                LIMIT 20
            """).fetchall()

            for r in borme_emp_rows:
                entry = {
                    'empresa': safe_str(r[0]),
                    'provincia': safe_str(r[1]),
                    'domicilio': safe_str(r[2]),
                    'capital_euros': safe_float(r[3]),
                    'fecha_constitucion': safe_str(r[4]),
                    'hoja_registral': safe_str(r[5]),
                    'fecha_borme': date_to_str(r[6]),
                }
                # Avoid duplicates
                if not any(e['empresa'] == entry['empresa'] for e in borme['empresas_relacionadas']):
                    borme['empresas_relacionadas'].append(entry)

            borme_cargo_rows = con.execute(f"""
                SELECT empresa, cargo, tipo_acto, fecha_borme, provincia
                FROM borme_cargos
                WHERE empresa LIKE '%{palabra}%'
                LIMIT 50
            """).fetchall()

            for r in borme_cargo_rows:
                entry = {
                    'empresa': safe_str(r[0]),
                    'cargo': safe_str(r[1]),
                    'tipo_acto': safe_str(r[2]),
                    'fecha_borme': date_to_str(r[3]),
                    'provincia': safe_str(r[4]),
                }
                borme['cargos'].append(entry)

    log.info(f"  BORME empresas: {len(borme['empresas_relacionadas'])}, cargos: {len(borme['cargos'])}")

    # ── 11. Totales ───────────────────────────────────────────────────────────
    vol_nacional = sum(safe_float(r.get('importe_adjudicacion')) or 0 for r in nacional_data)
    vol_ted = sum(safe_float(r.get('importe_adjudicacion')) or 0 for r in ted_normalized)
    vol_galicia = sum(safe_float(r.get('importe_adjudicacion')) or 0 for r in galicia_data)
    vol_andalucia = sum(safe_float(r.get('importe_adjudicacion')) or 0 for r in andalucia_data)
    vol_catalunya = sum(safe_float(r.get('importe_adjudicacion')) or 0 for r in catalunya_data)
    vol_total = vol_nacional + vol_ted + vol_galicia + vol_andalucia + vol_catalunya
    adj_total = len(all_data)

    # ── 12. Top 50 adjudicaciones recientes (detalle) ─────────────────────────
    def format_adj(r):
        return {
            'fuente': r.get('_fuente', 'nacional'),
            'id': safe_str(r.get('id')),
            'expediente': safe_str(r.get('expediente')),
            'objeto': safe_str(r.get('objeto')),
            'organo_contratante': safe_str(r.get('organo_contratante')),
            'ciudad': safe_str(r.get('ciudad_organo')),
            'cpv': safe_str(r.get('cpv_principal')),
            'importe_licitacion': safe_float(r.get('importe_sin_iva')),
            'importe_adjudicacion': safe_float(r.get('importe_adjudicacion')),
            'num_ofertas': safe_float(r.get('num_ofertas')) if r.get('num_ofertas') is not None else None,
            'fecha_adjudicacion': date_to_str(r.get('fecha_adjudicacion')),
            'fecha_publicacion': date_to_str(r.get('fecha_publicacion')),
            'url': safe_str(r.get('url')),
        }

    top50 = [format_adj(r) for r in all_data[:50]]

    # ── Assemble profile ──────────────────────────────────────────────────────
    profile = {
        "empresa": empresa_nombre,
        "cif": cif,
        "generado": datetime.utcnow().isoformat() + "Z",
        "fuentes": {
            "nacional": len(nacional_data),
            "ted": len(ted_normalized),
            "euskadi": len(euskadi_data),
            "madrid": len(madrid_data),
            "galicia": len(galicia_data),
            "andalucia": len(andalucia_data),
            "catalunya": len(catalunya_data),
            "borme_empresas": len(borme['empresas_relacionadas']),
            "borme_cargos": len(borme['cargos']),
        },
        "adjudicaciones_total": adj_total,
        "volumen_total_eur": round(vol_total, 2),
        "volumen_nacional_eur": round(vol_nacional, 2),
        "volumen_ted_eur": round(vol_ted, 2),
        "volumen_galicia_eur": round(vol_galicia, 2),
        "volumen_andalucia_eur": round(vol_andalucia, 2),
        "volumen_catalunya_eur": round(vol_catalunya, 2),
        "cpvs_activos": cpvs_activos,
        "organismos_recurrentes": organismos[:30],
        "competidores": competidores,
        "ciclos_renovacion": ciclos_renovacion[:50],
        # ── Nuevos módulos predictivos v2.1 ──────────────────────────────────
        "estacionalidad_global": estacionalidad_global,
        "tendencia_gasto": tendencia_gasto,
        "oportunidades_no_incumbente": oportunidades_no_incumbente,
        "organismos_compatibles": organismos_compatibles,
        # ─────────────────────────────────────────────────────────────────────
        "bajas_ganadoras": bajas,
        "evolucion_anual": evolucion_anual,
        "distribucion_geografica": distribucion_geografica,
        "borme": borme,
        "adjudicaciones": top50,
    }

    log.info(
        f"Perfil construido: {adj_total} adj | {round(vol_total/1e6, 1)}M EUR | "
        f"{len(cpvs_activos)} CPVs | {len(ciclos_renovacion)} ciclos | "
        f"{len(tendencia_gasto)} tendencias | {len(oportunidades_no_incumbente)} oportunidades | "
        f"{len(organismos_compatibles)} orgs compatibles"
    )
    return profile


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Profiler de empresa v2 (DuckDB)")
    parser.add_argument('positional', nargs='*', help='CIF [nombre_empresa]')
    parser.add_argument('--cif', help='CIF de la empresa')
    parser.add_argument('--nombre', default='', help='Nombre / hint de búsqueda')
    parser.add_argument('--output', default=str(OUTPUT_PATH), help='Path de salida JSON')
    args = parser.parse_args()

    # Resolve CIF and nombre
    cif = args.cif
    nombre = args.nombre

    if not cif and args.positional:
        cif = args.positional[0]
    if not nombre and len(args.positional) >= 2:
        nombre = ' '.join(args.positional[1:])

    if not cif:
        parser.error("Proporciona un CIF: python3 profiler_v2.py B15044357 o --cif B15044357")

    cif = cif.strip().upper()
    log.info(f"=== profiler_v2.py CIF={cif} nombre='{nombre}' ===")

    if not DB_PATH.exists():
        log.error(f"DuckDB no encontrada en {DB_PATH}")
        sys.exit(1)

    profile = build_profile(cif, nombre)

    # Use per-CIF output path if default was not overridden
    if args.output == str(OUTPUT_PATH):
        profiles_dir = OUTPUT_PATH.parent / 'profiles'
        profiles_dir.mkdir(parents=True, exist_ok=True)
        out_path = profiles_dir / f"{cif}.json"
    else:
        out_path = Path(args.output)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(profile, f, ensure_ascii=False, indent=2, default=str)

    log.info(f"Output guardado en {out_path}")
    log.info(f"Resumen: {profile['adjudicaciones_total']} adj | {round(profile['volumen_total_eur']/1e6, 1)}M EUR | {len(profile['cpvs_activos'])} CPVs | {len(profile['competidores'])} competidores")
    print(f"✓ Perfil guardado: {out_path}")


if __name__ == "__main__":
    main()
