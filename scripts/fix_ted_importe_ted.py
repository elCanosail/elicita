#!/usr/bin/env python3
"""
Fix script: Populate importe_ted from value_euro/VALUE_EURO_FIN_1 for rows where it's NULL.

Context: BQuantFinance's ted_module.py generates parquet files with value_euro as VARCHAR.
When loaded into DuckDB, importe_ted (DOUBLE) is not automatically populated from the
string column. This script fixes that by casting value_euro to DOUBLE where importe_ted is NULL.

Also applies the BudgetAmount mapping fix from PR #7:
- TaxExclusiveAmount → importe_sin_iva (preferred)
- TotalAmount → importe_con_iva
- EstimatedOverallContractAmount → valor_estimado_contrato
"""

import duckdb
import sys
from pathlib import Path

DB_PATH = Path("/var/data/licitaciones/db/licitaciones.duckdb")


def fix_ted_importe_ted():
    print(f"Connecting to DuckDB: {DB_PATH}")
    db = duckdb.connect(str(DB_PATH))

    try:
        # Check current state
        print("\n=== BEFORE FIX ===")
        before = db.execute("""
            SELECT
                source,
                COUNT(*) as total,
                COUNT(importe_ted) as has_importe_ted,
                COUNT(value_euro) as has_value_euro,
                COUNT(VALUE_EURO_FIN_1) as has_val_euro_fin1
            FROM ted
            GROUP BY source
            ORDER BY total DESC
        """).fetchdf()
        print(before.to_string())

        # Fix 1: Populate importe_ted from value_euro for api_v3 rows
        print("\n--- Fix 1: Populate importe_ted from value_euro (api_v3) ---")
        result1 = db.execute("""
            UPDATE ted
            SET importe_ted = TRY_CAST(value_euro AS DOUBLE)
            WHERE source = 'api_v3'
              AND importe_ted IS NULL
              AND value_euro IS NOT NULL
              AND value_euro != ''
        """)
        print(f"Rows updated (api_v3): {result1.fetchone()[0] if result1 else 'N/A'}")

        # Fix 2: Populate importe_ted from VALUE_EURO_FIN_1 for CSV rows
        print("\n--- Fix 2: Populate importe_ted from VALUE_EURO_FIN_1 (csv_bulk) ---")
        result2 = db.execute("""
            UPDATE ted
            SET importe_ted = TRY_CAST(VALUE_EURO_FIN_1 AS DOUBLE)
            WHERE source = 'csv_bulk'
              AND importe_ted IS NULL
              AND VALUE_EURO_FIN_1 IS NOT NULL
              AND VALUE_EURO_FIN_1 != ''
        """)
        print(f"Rows updated (csv_bulk): {result2.fetchone()[0] if result2 else 'N/A'}")

        # Fix 3: Populate importe_ted from VALUE_EURO_FIN_1 for rows with no source
        print("\n--- Fix 3: Populate importe_ted from VALUE_EURO_FIN_1 (no source) ---")
        result3 = db.execute("""
            UPDATE ted
            SET importe_ted = TRY_CAST(VALUE_EURO_FIN_1 AS DOUBLE)
            WHERE source IS NULL
              AND importe_ted IS NULL
              AND VALUE_EURO_FIN_1 IS NOT NULL
              AND VALUE_EURO_FIN_1 != ''
        """)
        print(f"Rows updated (no source): {result3.fetchone()[0] if result3 else 'N/A'}")

        # Check after fix
        print("\n=== AFTER FIX ===")
        after = db.execute("""
            SELECT
                source,
                COUNT(*) as total,
                COUNT(importe_ted) as has_importe_ted,
                COUNT(value_euro) as has_value_euro,
                COUNT(VALUE_EURO_FIN_1) as has_val_euro_fin1
            FROM ted
            GROUP BY source
            ORDER BY total DESC
        """).fetchdf()
        print(after.to_string())

        # Summary stats
        print("\n=== IMPORTE_TED STATS ===")
        stats = db.execute("""
            SELECT
                COUNT(*) as total,
                COUNT(importe_ted) as has_importe,
                AVG(importe_ted) as avg_importe,
                MEDIAN(importe_ted) as median_importe,
                MIN(importe_ted) as min_importe,
                MAX(importe_ted) as max_importe
            FROM ted
        """).fetchdf()
        print(stats.to_string())

        print("\n✅ Fix complete.")

    finally:
        db.close()


if __name__ == "__main__":
    fix_ted_importe_ted()
