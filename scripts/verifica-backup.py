#!/usr/bin/env python3
"""Verificación de restauración de los backups DuckDB de elicita
(propuestas 2026-10-07, C · generalizada a multi-base por la tarea 37).

Abre el backup en modo read-only, valida que la tabla clave exista, cuenta filas y
compara con la referencia capturada justo antes de la copia (debe ser exacta: el
fichero solo cambia por promociones atómicas y se copió tras verificar estabilidad).
Para web-state.duckdb el .wal debe estar JUNTO al fichero (mismo basename + ".wal"):
DuckDB read-only lee y aplica el WAL en memoria al abrir el par.

Uso: verifica-backup.py <backup.duckdb> <count_esperado> [tabla]
Patrón read-only ya usado en tareas 4/15/18 del backlog.
"""
import sys

import duckdb


def main() -> int:
    if len(sys.argv) < 3:
        print("uso: verifica-backup.py <backup.duckdb> <count_esperado> [tabla]")
        return 2
    backup = sys.argv[1]
    esperado = int(sys.argv[2])
    tabla = sys.argv[3] if len(sys.argv) > 3 else "calidad"

    try:
        con = duckdb.connect(backup, read_only=True)
    except Exception as e:  # noqa: BLE001 — informe claro del fallo de apertura
        print(f"FALLO: el backup no abre read-only: {e}")
        return 1

    tablas = [r[0] for r in con.execute("SHOW TABLES").fetchall()]
    if tabla not in tablas:
        print(f"FALLO: tabla {tabla} no está en el backup (tablas: {tablas[:10]}{'…' if len(tablas) > 10 else ''})")
        return 1

    conteo = con.execute(f"SELECT COUNT(*) FROM {tabla}").fetchone()[0]
    try:
        muestra = con.execute(
            f"SELECT COUNT(*) FROM {tabla} WHERE fecha_publicacion >= '2026-01-01'"
        ).fetchone()[0]
    except Exception:  # noqa: BLE001 — columna ausente no invalida la verificación
        muestra = -1

    print(f"backup abre read-only OK · tabla {tabla}: {conteo:,} filas (esperadas {esperado:,})"
          + (f" · filas 2026+: {muestra:,}" if muestra >= 0 else ""))
    if conteo != esperado:
        print(f"FALLO: conteo del backup ({conteo}) != referencia pre-copia ({esperado})")
        return 1
    print("VERIFICACIÓN DE RESTAURACIÓN OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
