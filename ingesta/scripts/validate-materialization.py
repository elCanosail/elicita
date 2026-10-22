#!/usr/bin/env python3
"""Valida una DuckDB candidata frente a la base viva antes del swap."""
import os
import sys
from datetime import date, timedelta

import duckdb

candidate_path = os.environ["CANDIDATE_DB"]
live_path = os.environ["LIVE_DB"]


def metrics(path):
    con = duckdb.connect(path, read_only=True)
    try:
        return con.execute("""
            SELECT count(*) AS total,
                   max(fecha_publicacion) AS max_fecha,
                   count(*) - count(DISTINCT id) AS duplicate_ids
            FROM contratos_vivos
        """).fetchone()
    finally:
        con.close()


candidate = metrics(candidate_path)
live = metrics(live_path)
print(f"candidate total={candidate[0]} max_fecha={candidate[1]} duplicate_ids={candidate[2]}")
print(f"live total={live[0]} max_fecha={live[1]} duplicate_ids={live[2]}")

errors = []
if candidate[0] < int(live[0] * 0.90):
    errors.append("candidate volume dropped by more than 10%")
if candidate[1] is None or candidate[1] < live[1]:
    errors.append("candidate max date regressed")
if candidate[1] is None or candidate[1] < date.today() - timedelta(days=3):
    errors.append("candidate remains more than 3 days stale")
if candidate[2] != 0:
    errors.append(f"candidate has {candidate[2]} duplicate ids")

if errors:
    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)
    sys.exit(1)
print("VALIDATION_OK")
