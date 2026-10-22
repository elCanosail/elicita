#!/usr/bin/env python3
"""
fetch_catalunya_menores.py — Descarga contratos menores Generalitat Catalunya
═══════════════════════════════════════════════════════════════════════════════
Fuente:    Socrata Open Data API (Transparència Catalunya)
Dataset:   qjue-2pk9 — Contractació menor de la Generalitat de Catalunya
Endpoint:  https://analisi.transparenciacatalunya.cat/resource/qjue-2pk9.json
Registros: ~866,557 (2025-05)

Estrategia:
  - Paginación por $limit + $offset (máx 50K/req recomendado por Socrata)
  - $order=:id para orden estable entre requests
  - Guarda directamente a Parquet (sin JSON intermedio)
  - Incremental: puede reanudar desde offset guardado

Uso:
  python3 fetch_catalunya_menores.py
  python3 fetch_catalunya_menores.py --resume
  python3 fetch_catalunya_menores.py --batch-size 50000
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

import pandas as pd
import requests

# ── CONFIGURACIÓN ──────────────────────────────────────────────────────────

SOCRATA_BASE = "https://analisi.transparenciacatalunya.cat/resource"
DATASET_ID = "qjue-2pk9"
API_URL = f"{SOCRATA_BASE}/{DATASET_ID}.json"

DEFAULT_BATCH_SIZE = 50000  # Socrata recomienda ≤50K
MAX_RETRIES = 5
RETRY_DELAY = 3  # segundos

# Salida: dentro del árbol de datos de Elicita
OUTPUT_DIR = Path("/var/data/licitaciones/data/catalunya/contratacion")
OUTPUT_FILE = OUTPUT_DIR / "contratos_menores_generalitat.parquet"
CHECKPOINT_FILE = OUTPUT_DIR / ".catalunya_menores_checkpoint.json"

# Columnas que mapeamos al esquema canónico de Elicita
# Las columnas Socrata usan snake_case catalán; las convertimos al estilo
# existente en la tabla "catalunya" de DuckDB.
CATALUNYA_SCHEMA = {
    # Socrata → Canonical DuckDB
    "any": "Any",
    "codi_d_expedient": "Codi d'expedient",
    "departament_d_adscripci": "Departament d'adscripció",
    "rgan_de_contractaci": "Òrgan de contractació",
    "mbit_subjectiu": "Àmbit subjectiu",
    "tipus_de_contracte": "Tipus de contracte",
    "procediment_d_adjudicaci": "Procediment d'adjudicació",
    "objecte_del_contracte": "Descripció del contracte",
    "import_adjudicat_sense_iva": "Import adjudicat sense IVA",
    "empresa_adjudicat_ria": "Empresa adjudicatària",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


def fetch_batch(offset, limit):
    """Descarga un batch desde Socrata con retry."""
    params = {
        "$limit": limit,
        "$offset": offset,
        "$order": ":id",  # orden estable por ID interno
    }
    headers = {
        "Accept": "application/json",
        "User-Agent": "elicita-bot/1.0 (contratos@elicita.es)",
    }

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(API_URL, params=params, headers=headers, timeout=60)
            if resp.status_code == 200:
                return resp.json()
            elif resp.status_code in (429, 500, 502, 503, 504):
                wait = min(RETRY_DELAY * (2 ** attempt), 120)
                log.warning(f"HTTP {resp.status_code} (intento {attempt + 1}/{MAX_RETRIES}), esperando {wait}s…")
                time.sleep(wait)
            else:
                log.error(f"HTTP {resp.status_code}: {resp.text[:200]}")
                return None
        except requests.exceptions.Timeout:
            wait = min(RETRY_DELAY * (attempt + 1), 120)
            log.warning(f"Timeout (intento {attempt + 1}/{MAX_RETRIES}), esperando {wait}s…")
            time.sleep(wait)
        except requests.exceptions.RequestException as e:
            wait = min(RETRY_DELAY * (attempt + 1), 120)
            log.warning(f"Error de red (intento {attempt + 1}/{MAX_RETRIES}): {e}, esperando {wait}s…")
            time.sleep(wait)

    log.error(f"Todos los intentos fallaron para offset={offset}")
    return None


def get_total_records():
    """Obtiene el conteo total de registros."""
    resp = requests.get(
        API_URL,
        params={"$select": "count(*)"},
        headers={"Accept": "application/json"},
        timeout=30,
    )
    if resp.status_code == 200:
        data = resp.json()
        return int(data[0]["count"])
    log.error(f"No se pudo obtener conteo total: HTTP {resp.status_code}")
    return 0


def save_checkpoint(offset, total):
    """Guarda progreso para reanudación."""
    CHECKPOINT_FILE.write_text(
        json.dumps({
            "offset": offset,
            "total": total,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }, indent=2),
        encoding="utf-8",
    )


def load_checkpoint():
    """Carga progreso previo si existe."""
    if CHECKPOINT_FILE.exists():
        data = json.loads(CHECKPOINT_FILE.read_text(encoding="utf-8"))
        return data.get("offset", 0)
    return 0


def fetch_all(batch_size=DEFAULT_BATCH_SIZE, resume=False):
    """Descarga todos los registros paginados."""
    total = get_total_records()
    log.info(f"Dataset: {DATASET_ID} | Total registros: {total:,}")

    if total == 0:
        log.error("No se pudo determinar el tamaño del dataset")
        return None

    offset = load_checkpoint() if resume else 0
    if offset > 0:
        log.info(f"Reanudando desde offset {offset:,}")

    all_records = []
    fetched = 0
    start_time = time.time()

    while offset < total:
        log.info(f"Descargando offset {offset:,} / {total:,} …")
        batch = fetch_batch(offset, batch_size)

        if batch is None:
            log.error(f"Fallo irrecuperable en offset {offset:,}. Guardando progreso.")
            break

        if not batch:
            log.info("Batch vacío — fin de datos")
            break

        all_records.extend(batch)
        fetched += len(batch)
        offset += len(batch)

        # Guardar checkpoint cada batch
        save_checkpoint(offset, total)

        # Estadísticas
        elapsed = time.time() - start_time
        rate = fetched / elapsed if elapsed > 0 else 0
        eta = (total - offset) / rate if rate > 0 else 0
        log.info(f"  → {fetched:,} descargados | {rate:.0f} reg/s | ETA {eta / 60:.1f}min")

        # Rate-limiting amable con Socrata
        time.sleep(0.5)

    log.info(f"Descarga completada: {fetched:,} registros en {(time.time() - start_time) / 60:.1f}min")
    return all_records


def transform_to_df(records):
    """Convierte registros Socrata a DataFrame con esquema canónico."""
    if not records:
        return pd.DataFrame()

    df = pd.DataFrame(records)

    # Renombrar columnas al esquema canónico
    df = df.rename(columns=CATALUNYA_SCHEMA)

    # Añadir metadatos
    df["_archivo_origen"] = "contratos_menores_generalitat_socrata"
    df["_fecha_ingesta"] = pd.Timestamp.now().strftime("%Y-%m-%dT%H:%M:%S")

    # Normalizar tipos
    for col in df.columns:
        if df[col].dtype == "object":
            df[col] = df[col].astype(str).replace("nan", "").replace("None", "")

    # Normalizar importe: quitar separadores de miles catalanes, convertir a float
    import_col = "Import adjudicat sense IVA"
    if import_col in df.columns:
        df[import_col] = (
            df[import_col]
            .astype(str)
            .str.replace(".", "", regex=False)   # separador de miles
            .str.replace(",", ".", regex=False)  # separador decimal
            .str.replace("€", "", regex=False)
            .str.replace(" ", "", regex=False)
            .replace("", "0")
        )
        df[import_col] = pd.to_numeric(df[import_col], errors="coerce")

    # Normalizar año
    any_col = "Any"
    if any_col in df.columns:
        df[any_col] = pd.to_numeric(df[any_col], errors="coerce").astype("Int64")

    return df


def save_parquet(df):
    """Guarda DataFrame a Parquet en la estructura de Elicita."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Si ya existe, hacer merge (upsert por Codi d'expedient)
    if OUTPUT_FILE.exists():
        log.info(f"Parquet existente encontrado: {OUTPUT_FILE}")
        df_existing = pd.read_parquet(OUTPUT_FILE)
        log.info(f"  → {len(df_existing):,} registros existentes")

        # Concatenar y eliminar duplicados por expediente (más reciente gana)
        df_combined = pd.concat([df_existing, df], ignore_index=True)
        key_col = "Codi d'expedient"
        if key_col in df_combined.columns:
            # Ordenar por fecha de ingesta descendente y quedarse con el primero
            df_combined = df_combined.sort_values("_fecha_ingesta", ascending=False)
            df_combined = df_combined.drop_duplicates(subset=[key_col], keep="first")
        else:
            log.warning(f"Columna {key_col} no encontrada — no se deduplica")

        df = df_combined

    df.to_parquet(OUTPUT_FILE, index=False, compression="snappy")
    size_mb = OUTPUT_FILE.stat().st_size / 1024 / 1024
    log.info(f"💾 Guardado: {OUTPUT_FILE} | {len(df):,} registros | {size_mb:.1f}MB")
    return len(df)


def main():
    parser = argparse.ArgumentParser(description="Descarga contratos menores Catalunya desde Socrata")
    parser.add_argument("--resume", action="store_true", help="Reanudar desde checkpoint")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="Tamaño de batch (default 50000)")
    parser.add_argument("--dry-run", action="store_true", help="Solo mostrar info, no descargar")
    args = parser.parse_args()

    total = get_total_records()
    log.info(f"═══ Contratos Menores Generalitat Catalunya ═══")
    log.info(f"Dataset ID : {DATASET_ID}")
    log.info(f"Total      : {total:,} registros")
    log.info(f"Batch size : {args.batch_size:,}")
    log.info(f"Output     : {OUTPUT_FILE}")

    if args.dry_run:
        log.info("Dry-run — saliendo sin descargar")
        return 0

    records = fetch_all(batch_size=args.batch_size, resume=args.resume)
    if records is None:
        log.error("Fallo en descarga")
        return 1

    if not records:
        log.info("Sin registros nuevos")
        return 0

    df = transform_to_df(records)
    n_saved = save_parquet(df)

    # Limpiar checkpoint al completar
    if CHECKPOINT_FILE.exists():
        CHECKPOINT_FILE.unlink()
        log.info("Checkpoint eliminado — descarga completada")

    log.info(f"🏁 Finalizado: {n_saved:,} registros en DuckDB-ready Parquet")
    return 0


if __name__ == "__main__":
    sys.exit(main())
