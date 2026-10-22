#!/usr/bin/env python3
"""Carga boe_contracts.json en tabla DuckDB 'boe'."""
import duckdb
import json
import os
import pandas as pd

DB_PATH = '/var/data/licitaciones/db/licitaciones.duckdb'
JSON_PATH = os.path.join(os.path.dirname(__file__), 'data', 'boe_contracts.json')


def parse_fecha(val):
    """Convierte YYYY-MM-DD string a date; null/invalid -> None."""
    if val is None or val == '' or pd.isna(val):
        return None
    try:
        return pd.Timestamp(val).date()
    except Exception:
        return None


def main():
    with open(JSON_PATH, 'r') as f:
        data = json.load(f)

    contratos = data.get('contratos', [])
    print(f"BOE: {len(contratos)} contratos para cargar")

    rows = []
    for c in contratos:
        raw_id = c.get('id', '')
        if raw_id.startswith('BOE:'):
            raw_id = raw_id[4:]

        cpvs = c.get('cpvs') or []
        # Descartar 'desconocido' y quedarnos con valores numéricos limpios
        cpvs_limpios = []
        for cpv in cpvs:
            if cpv and str(cpv).strip().lower() != 'desconocido':
                cpvs_limpios.append(str(cpv).strip())

        cpv = cpvs_limpios[0] if cpvs_limpios else None

        importe = c.get('importe_licitacion')
        if importe is None or importe == '':
            importe = 0.0
        try:
            importe = float(importe)
        except Exception:
            importe = 0.0

        rows.append({
            'id': raw_id,
            'fuente': 'BOE',
            'expediente': raw_id,
            'organismo': c.get('organismo'),
            'objeto': c.get('titulo'),
            'cpv': cpv,
            'cpvs': cpvs_limpios,
            'importe_licitacion': importe,
            'importe_adjudicacion': c.get('importe_adjudicacion') or 0.0,
            'fecha_publicacion': parse_fecha(c.get('fecha_publicacion')),
            'fecha_fin': parse_fecha(c.get('fecha_fin')),
            'url': c.get('url_fuente'),
            'estado': c.get('estado'),
            'adjudicatario': c.get('adjudicatario'),
            'nif_adjudicatario': c.get('nif_adjudicatario'),
        })

    df = pd.DataFrame(rows)
    # Asegurar tipos de columnas vacías
    df['id'] = df['id'].astype(str)
    df['fuente'] = df['fuente'].astype(str)
    df['expediente'] = df['expediente'].astype(str)
    df['organismo'] = df['organismo'].astype(str).replace('nan', None).replace('None', None)
    df['objeto'] = df['objeto'].astype(str).replace('nan', None).replace('None', None)
    df['cpv'] = df['cpv'].astype(str).replace('nan', None).replace('None', None)
    df['url'] = df['url'].astype(str).replace('nan', None).replace('None', None)
    df['estado'] = df['estado'].astype(str).replace('nan', None).replace('None', None)
    # list columns: mantener como object de listas para DuckDB

    con = duckdb.connect(DB_PATH)
    con.execute("DROP TABLE IF EXISTS boe")
    con.register('df_boe', df)
    con.execute("""
        CREATE TABLE boe AS
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
            fecha_publicacion::DATE AS fecha_publicacion,
            fecha_fin::DATE AS fecha_fin,
            url::VARCHAR AS url,
            estado::VARCHAR AS estado,
            adjudicatario::VARCHAR AS adjudicatario,
            nif_adjudicatario::VARCHAR AS nif_adjudicatario
        FROM df_boe
    """)
    con.execute("DROP VIEW IF EXISTS df_boe")  # limpia registro temporal
    filas = con.execute("SELECT COUNT(*) FROM boe").fetchone()[0]
    print(f"Tabla 'boe' creada con {filas} filas")
    con.close()


if __name__ == '__main__':
    main()
