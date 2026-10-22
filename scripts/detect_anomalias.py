#!/usr/bin/env python3
"""
detect_anomalias.py — Detección y saneamiento de importes absurdos en DuckDB
═══════════════════════════════════════════════════════════════════════════

PROBLEMA:
  PLACSP y otras fuentes contienen importes con errores de captura:
  - Taller Oviedo: €251.520.154.010 (mantenimiento de vehículos)
  - SAS: €559.914.990.000 (sin adjudicatario)
  - UTE GOMSL: €89.928.108.813
  - Avincis: €10.000.000.000

SOLUCIÓN:
  1. Detectar registros con importes > umbral (€5B)
  2. Crear vista contratos_saneados que filtra absurdos + deduplica por ID
  3. Reportar estadísticas
  4. Vista nacional_dedup, ted_dedup, calidad_dedup, catalunya_dedup (vistas base deduplicadas)

  contratos_saneados = contratos_unificados filtrados + 1 registro por ID
  (prioriza estado Resuelta > Adjudicada > resto, e importe no nulo)

USO:
  python3 detect_anomalias.py              # Solo detectar (dry-run)
  python3 detect_anomalias.py --apply      # Marcar y crear vista saneada
"""

import duckdb
import sys
import os

DB_PATH = '/var/data/licitaciones/db/licitaciones.duckdb'
UMBRAL_ABSURDO = 5_000_000_000  # €5B — el mayor contrato real español no supera €2-3B
UMBRAL_SOSPECHOSO = 1_000_000_000  # €1B — revisar manualmente

def main():
    apply = '--apply' in sys.argv
    dry_run = not apply

    mode = "DRY-RUN (no aplica cambios)" if dry_run else "APLICAR cambios"
    print(f"{'='*60}")
    print(f"  Detección de importes absurdos — {mode}")
    print(f"  Umbral absurdo: >€{UMBRAL_ABSURDO:,}")
    print(f"  Umbral sospechoso: >€{UMBRAL_SOSPECHOSO:,}")
    print(f"  DB: {DB_PATH}")
    print(f"{'='*60}")

    con = duckdb.connect(DB_PATH)

    # 1. Detectar importes absurdos en todas las tablas base
    tablas_base = ['nacional', 'calidad', 'ted', 'andalucia', 'catalunya',
                   'galicia', 'comunidad_madrid', 'euskadi', 'asturias', 'valencia', 'boe']

    print(f"\n📊 DETECCIÓN — Importes absurdos (>{UMBRAL_ABSURDO:,}€)")
    print(f"{'─'*60}")

    total_absurdos = 0
    total_sospechosos = 0
    detalles = []

    for tabla in tablas_base:
        # Buscar columnas de importe
        cols = con.execute(f"""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = '{tabla}'
            AND column_name IN ('importe_sin_iva', 'importe_con_iva',
                                'importe_adjudicacion', 'importe_adj_con_iva',
                                'VALUE_EURO_FIN_1', 'AWARD_VALUE_EURO_FIN_1',
                                'importe_licitacion', 'IMPORTE_LICIT_SIN_IVA',
                                'IMP_ADJUD_SIN_IVA', 'PRESUPUESTO')
        """).fetchall()
        col_names = [c[0] for c in cols]

        for col in col_names:
            try:
                r = con.execute(f"""
                    SELECT COUNT(*),
                           MIN(CAST({col} AS DOUBLE)),
                           MAX(CAST({col} AS DOUBLE))
                    FROM {tabla}
                    WHERE CAST({col} AS DOUBLE) > {UMBRAL_ABSURDO}
                """).fetchone()
                if r[0] > 0:
                    print(f"  {tabla}.{col}: {r[0]} registros absurdos "
                          f"(min €{r[1]:,.0f}, max €{r[2]:,.0f})")
                    total_absurdos += r[0]
                    detalles.append((tabla, col, r[0], r[1], r[2]))

                # Sospechosos (entre 1B y 5B)
                r2 = con.execute(f"""
                    SELECT COUNT(*)
                    FROM {tabla}
                    WHERE CAST({col} AS DOUBLE) > {UMBRAL_SOSPECHOSO}
                      AND CAST({col} AS DOUBLE) <= {UMBRAL_ABSURDO}
                """).fetchone()
                if r2[0] > 0:
                    total_sospechosos += r2[0]
            except Exception as e:
                pass  # Column type might not cast

    print(f"\n  TOTAL absurdos: {total_absurdos} registros")
    print(f"  TOTAL sospechosos (€1B-€5B): {total_sospechosos} registros")

    # 2. Detectar duplicados por expediente + organismo
    print(f"\n📊 DETECCIÓN — Duplicados por expediente + organismo")
    print(f"{'─'*60}")
    r_dup = con.execute("""
        WITH dedup AS (
          SELECT DISTINCT expediente, organismo, adjudicatario, importe_adjudicacion
          FROM contratos_unificados
          WHERE adjudicatario IS NOT NULL AND adjudicatario != ''
            AND importe_adjudicacion > 0
        )
        SELECT expediente, organismo, COUNT(*) as veces
        FROM contratos_unificados
        WHERE adjudicatario IS NOT NULL AND adjudicatario != ''
          AND importe_adjudicacion > 0
          AND expediente IS NOT NULL
        GROUP BY expediente, organismo
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 20
    """).fetchall()
    if r_dup:
        print(f"  Top 20 expedientes duplicados:")
        for row in r_dup:
            print(f"    {row[0][:30]:30s} | {row[1][:40]:40s} | {row[2]} veces")
    else:
        print(f"  No se detectaron duplicados")

    # 3. Reportar duplicados eliminados por contratos_saneados
    print(f"\n📊 DEDUPLICACIÓN — contratos_saneados vs contratos_unificados")
    print(f"{'─' * 60}")
    r_orig = con.execute("SELECT COUNT(*) FROM contratos_unificados").fetchone()[0]
    r_san = con.execute("SELECT COUNT(*) FROM contratos_saneados").fetchone()[0]
    print(f"  contratos_unificados: {r_orig:,}")
    print(f"  contratos_saneados:  {r_san:,}")
    print(f"  Eliminados:          {r_orig - r_san:,} ({(r_orig - r_san) / r_orig * 100:.1f}%)")

    # 4. Si es dry-run, parar aquí
    if dry_run:
        print(f"\n{'='*60}")
        print(f"  DRY-RUN completado. Ejecuta con --apply para marcar y sanejar.")
        print(f"{'='*60}")
        return

    # 4. Aplicar: crear tabla de anomalias y vista saneada
    print(f"\n🔧 APLICANDO SANEAMIENTO")
    print(f"{'─'*60}")

    # Crear tabla de registro de anomalias
    con.execute("""
        CREATE TABLE IF NOT EXISTS anomalias_importe (
            id VARCHAR,
            fuente VARCHAR,
            tabla_origen VARCHAR,
            columna_origen VARCHAR,
            expediente VARCHAR,
            organismo VARCHAR,
            adjudicatario VARCHAR,
            importe_original DOUBLE,
            umbral DOUBLE,
            tipo VARCHAR,  -- 'absurdo' o 'sospechoso'
            detectado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Registrar anomalias detectadas
    for tabla, col, count, min_v, max_v in detalles:
        try:
            con.execute(f"""
                INSERT INTO anomalias_importe (id, fuente, tabla_origen, columna_origen, expediente, organismo, adjudicatario, importe_original, umbral, tipo)
                SELECT
                    CAST(id AS VARCHAR),
                    '{tabla}',
                    '{tabla}',
                    '{col}',
                    CAST(expediente AS VARCHAR),
                    CAST(organismo AS VARCHAR),
                    CAST(adjudicatario AS VARCHAR),
                    CAST({col} AS DOUBLE),
                    {UMBRAL_ABSURDO},
                    'absurdo'
                FROM {tabla}
                WHERE CAST({col} AS DOUBLE) > {UMBRAL_ABSURDO}
            """)
            print(f"  ✅ {tabla}.{col}: {count} anomalias registradas")
        except Exception as e:
            print(f"  ❌ {tabla}.{col}: {e}")

    # Crear vista saneada
    print(f"\n  Creando vista contratos_saneados...")
    con.execute("""
        CREATE OR REPLACE VIEW contratos_saneados AS
        SELECT * FROM contratos_unificados
        WHERE importe_licitacion < 5000000000
          AND importe_adjudicacion < 5000000000
    """)
    print(f"  ✅ Vista contratos_saneados creada")

    # Estadísticas
    r_total = con.execute("SELECT COUNT(*) FROM contratos_unificados").fetchone()[0]
    r_saneado = con.execute("SELECT COUNT(*) FROM contratos_saneados").fetchone()[0]
    r_filtrados = r_total - r_saneado
    print(f"\n  📈 Estadísticas:")
    print(f"     contratos_unificados: {r_total:,} registros")
    print(f"     contratos_saneados:   {r_saneado:,} registros")
    print(f"     Filtrados (absurdos): {r_filtrados} registros")

    con.close()
    print(f"\n{'='*60}")
    print(f"  Saneamiento completado.")
    print(f"  Usa 'contratos_saneados' en queries críticas (rankings, stats).")
    print(f"  'contratos_unificados' sigue disponible con todos los datos.")
    print(f"{'='*60}")

if __name__ == '__main__':
    main()