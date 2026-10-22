#!/usr/bin/env python3
"""
load-borme-calidad.py — Carga tablas BORME y calidad en DuckDB desde Parquets.

Descarga los datasets de BquantFinance/licitaciones-espana (v2026.02), extrae
los Parquet, y los carga como tablas DuckDB. También construye nif_canonical
a partir de los adjudicatarios de contratos_vivos.

Tablas creadas:
  - borme_empresas  (~9.3M rows) — Registro mercantil, datos de empresas
  - borme_cargos    (~17.1M rows) — Cargos de empresas (nombramientos, ceses)
  - calidad         (~8.7M rows) — Indicadores de calidad por contrato (20 KPIs)
  - nif_canonical   (~10.7K rows) — NIF → nombre canónico derivado de contratos

Uso:
  python3 load-borme-calidad.py              # Descargar + cargar
  python3 load-borme-calidad.py --no-download # Solo cargar (Parquets ya extraídos)

Requiere:
  - DuckDB Python connector (pip install duckdb)
  - unrar (para calidad_licitaciones_resultado.rar)
  - Acceso write a /var/data/licitaciones/db/licitaciones.duckdb
  - PM2 elicita parado (para liberar el lock de DuckDB)
"""

import os
import sys
import time
import subprocess
import zipfile
import duckdb
from pathlib import Path

DB_PATH = '/var/data/licitaciones/db/licitaciones.duckdb'
RAW_DIR = Path('/var/data/licitaciones/raw')
DATA_DIR = Path('/var/data/licitaciones/data')
BORME_DIR = DATA_DIR / 'borme'
CALIDAD_DIR = DATA_DIR / 'calidad'

# BquantFinance release assets
BORME_URL = 'https://github.com/BquantFinance/licitaciones-espana/releases/download/v2026.02/borme.zip'
CALIDAD_URL = 'https://github.com/BquantFinance/licitaciones-espana/releases/download/v2026.02/calidad_licitaciones_resultado.rar'

DOWNLOAD = '--no-download' not in sys.argv


def download_and_extract():
    """Download and extract BORME and calidad datasets."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    # BORME
    borme_zip = RAW_DIR / 'borme.zip'
    if not borme_zip.exists() and DOWNLOAD:
        print(f"Downloading borme.zip...")
        subprocess.run(['curl', '-L', '--max-time', '3600', '--retry', '3',
                       '-o', str(borme_zip), BORME_URL], check=True)
    if borme_zip.exists():
        print(f"Extracting borme.zip...")
        BORME_DIR.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(borme_zip) as z:
            z.extractall(BORME_DIR)
        print(f"  ✅ BORME extracted to {BORME_DIR}")

    # Calidad (RAR format)
    calidad_rar = RAW_DIR / 'calidad.rar'
    if not calidad_rar.exists() and DOWNLOAD:
        print(f"Downloading calidad.rar...")
        subprocess.run(['curl', '-L', '--max-time', '3600', '--retry', '3',
                       '-o', str(calidad_rar), CALIDAD_URL], check=True)
    if calidad_rar.exists():
        print(f"Extracting calidad.rar...")
        CALIDAD_DIR.mkdir(parents=True, exist_ok=True)
        subprocess.run(['unrar', 'x', '-o+', str(calidad_rar), str(CALIDAD_DIR) + '/'],
                      check=True)
        print(f"  ✅ Calidad extracted to {CALIDAD_DIR}")


def load_tables():
    """Load Parquet files into DuckDB tables."""
    print(f"\nConnecting to {DB_PATH} (read-write)...")
    con = duckdb.connect(DB_PATH)

    # BORME empresas
    print("\n=== Loading borme_empresas ===")
    t0 = time.time()
    empresas_parquet = str(BORME_DIR / 'borme_empresas_pub.parquet')
    if not os.path.exists(empresas_parquet):
        print(f"❌ Not found: {empresas_parquet}")
        sys.exit(1)
    con.execute("DROP TABLE IF EXISTS borme_empresas")
    con.execute(f"CREATE TABLE borme_empresas AS SELECT * FROM read_parquet('{empresas_parquet}')")
    cnt = con.execute("SELECT COUNT(*) FROM borme_empresas").fetchone()[0]
    print(f"  ✅ borme_empresas: {cnt:,} rows ({time.time()-t0:.1f}s)")

    # BORME cargos
    print("\n=== Loading borme_cargos ===")
    t0 = time.time()
    cargos_parquet = str(BORME_DIR / 'borme_cargos_pub.parquet')
    if not os.path.exists(cargos_parquet):
        print(f"❌ Not found: {cargos_parquet}")
        sys.exit(1)
    con.execute("DROP TABLE IF EXISTS borme_cargos")
    con.execute(f"CREATE TABLE borme_cargos AS SELECT * FROM read_parquet('{cargos_parquet}')")
    cnt = con.execute("SELECT COUNT(*) FROM borme_cargos").fetchone()[0]
    print(f"  ✅ borme_cargos: {cnt:,} rows ({time.time()-t0:.1f}s)")

    # Calidad
    print("\n=== Loading calidad ===")
    t0 = time.time()
    calidad_parquet = str(CALIDAD_DIR / 'calidad_licitaciones_resultado.parquet')
    if not os.path.exists(calidad_parquet):
        # Try to find any parquet in the directory
        parquets = list(CALIDAD_DIR.glob('*.parquet'))
        if not parquets:
            print(f"❌ No parquet in {CALIDAD_DIR}")
            sys.exit(1)
        calidad_parquet = str(parquets[0])
    con.execute("DROP TABLE IF EXISTS calidad")
    con.execute(f"CREATE TABLE calidad AS SELECT * FROM read_parquet('{calidad_parquet}')")
    cnt = con.execute("SELECT COUNT(*) FROM calidad").fetchone()[0]
    print(f"  ✅ calidad: {cnt:,} rows ({time.time()-t0:.1f}s)")

    # nif_canonical — derive from contracts
    print("\n=== Building nif_canonical ===")
    t0 = time.time()
    con.execute("DROP TABLE IF EXISTS nif_canonical")
    con.execute("""
        CREATE TABLE nif_canonical AS
        SELECT
            UPPER(nif_adjudicatario) AS nif,
            ANY_VALUE(adjudicatario) AS nombre
        FROM contratos_vivos
        WHERE nif_adjudicatario IS NOT NULL
          AND adjudicatario IS NOT NULL
          AND nif_adjudicatario != ''
        GROUP BY nif_adjudicatario
    """)
    cnt = con.execute("SELECT COUNT(*) FROM nif_canonical").fetchone()[0]
    print(f"  ✅ nif_canonical: {cnt:,} rows ({time.time()-t0:.1f}s)")

    # ── Compatibility view: nacional ──────────────────────────────────
    # profiler_v2.py queries 'nacional' table (old schema). Create a view
    # that maps contratos_vivos columns to old nacional schema so the
    # profiler works without code changes.
    con.execute("DROP VIEW IF EXISTS nacional")
    con.execute("""
    CREATE VIEW nacional AS
    SELECT
        id,
        expediente,
        objeto,
        organismo AS organo_contratante,
        NULL::VARCHAR AS nif_organo,
        NULL::VARCHAR AS ciudad_organo,
        cpv AS cpv_principal,
        cpvs,
        importe_licitacion AS importe_sin_iva,
        importe_adjudicacion,
        adjudicatario,
        nif_adjudicatario,
        NULL::INTEGER AS num_ofertas,
        NULL::BOOLEAN AS es_pyme,
        NULL::VARCHAR AS nuts,
        NULL::VARCHAR AS tipo_contrato,
        NULL::VARCHAR AS procedimiento,
        fecha_publicacion AS fecha_adjudicacion,
        fecha_publicacion,
        url,
        EXTRACT(YEAR FROM fecha_publicacion)::INTEGER AS ano
    FROM contratos_vivos
    """)
    cnt = con.execute("SELECT COUNT(*) FROM nacional").fetchone()[0]
    print(f"  ✅ nacional (view): {cnt:,} rows (compat with profiler_v2)")

    # Summary
    print("\n=== Final table list ===")
    tables = con.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name"
    ).fetchall()
    for t in tables:
        cnt = con.execute(f"SELECT COUNT(*) FROM {t[0]}").fetchone()[0]
        print(f"  {t[0]:30s} {cnt:>12,}")

    con.close()
    print("\n✅ All done!")


if __name__ == '__main__':
    download_and_extract()
    load_tables()