#!/usr/bin/env python3
"""Migración one-time: tablas web-owned → web-state.duckdb.

Ejecutar con elicita y elicita-mcp PARADOS (liberan el lock RW de
licitaciones.duckdb, necesario para abrirla en RO). Idempotente: salta las
tablas ya presentes en el destino.
"""
import duckdb
import sys

SRC = '/var/data/licitaciones/db/licitaciones.duckdb'
DST = '/var/data/licitaciones/db/web-state.duckdb'
TABLES = [
    'alertas',
    'api_keys',
    'api_usage_daily',
    'api_usage_monthly',
    'ia_resumenes',
    'ia_perfiles',
    'ia_matching_results',
    'pliegos_extraidos',
]

def tables_of(con, catalog, schema):
    # IMPORTANTE: information_schema.tables lista TODOS los catálogos attachados;
    # filtrar por catálogo, no solo por schema (ambos se llaman 'main').
    return {
        r[0]
        for r in con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_catalog = ? AND table_schema = ?",
            [catalog, schema],
        ).fetchall()
    }

def main():
    con = duckdb.connect(DST)
    con.execute(f"ATTACH '{SRC}' AS src (READ_ONLY)")
    dst_catalog = con.execute('SELECT current_database()').fetchone()[0]
    dst_tables = tables_of(con, dst_catalog, 'main')
    src_tables = tables_of(con, 'src', 'main')
    for t in TABLES:
        if t in dst_tables:
            n = con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
            print(f'skip (ya existe): {t} ({n} filas)')
            continue
        if t not in src_tables:
            print(f'AVISO: no existe en origen: {t} — skip')
            continue
        con.execute(f'CREATE TABLE {t} AS SELECT * FROM src.{t}')
        n = con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
        print(f'migrada: {t} ({n} filas)')
    # Tablas que nunca llegaron a existir en el origen: DDL según uso en código
    con.execute("""CREATE TABLE IF NOT EXISTS api_keys (
        id VARCHAR PRIMARY KEY,
        user_id VARCHAR NOT NULL,
        name VARCHAR,
        hash VARCHAR NOT NULL,
        prefix VARCHAR,
        created_at TIMESTAMP,
        last_used_at TIMESTAMP,
        expires_at TIMESTAMP,
        revoked BOOLEAN DEFAULT FALSE
    )""")
    con.execute("""CREATE TABLE IF NOT EXISTS api_usage_daily (
        user_id VARCHAR NOT NULL,
        date DATE NOT NULL,
        search_count INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, date)
    )""")
    con.execute("""CREATE TABLE IF NOT EXISTS api_usage_monthly (
        user_id VARCHAR NOT NULL,
        month VARCHAR NOT NULL,
        queries_used INTEGER DEFAULT 0,
        last_updated TIMESTAMP,
        PRIMARY KEY (user_id, month)
    )""")
    con.execute('DETACH src')
    con.close()
    print('OK')

if __name__ == '__main__':
    sys.exit(main())
