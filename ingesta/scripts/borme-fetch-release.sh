#!/usr/bin/env bash
# borme-fetch-release.sh — Comprueba el último release de BquantFinance/
# licitaciones-espana y, si es nuevo, descarga SOLO borme.zip (verificado por
# SHA256), lo extrae a /var/data/licitaciones/data/borme/ y deja marcador del
# tag descargado. El CARGA lo hace load-borme-incremental.py dentro del ciclo
# de materialización — este script toca ficheros, nunca la BD.
#
# Forense (2026-10-14): la ingesta BORME original (scripts/load-borme-calidad.py,
# commit 806607e) era un loader MANUAL de snapshots GitHub — nunca hubo cron y
# el último release hasta entonces era v2026.02 (datos hasta 2026-02-18).
# Este script automatiza la cadencia de descarga; v2026.10 cubre hasta
# 2026-10-01 y el XML diario (load-borme-incremental.py) cierra el resto.
#
# Cron (instalado 2026-10-14, ver informe):
#   10 3 * * * .../ingesta/scripts/borme-fetch-release.sh >> /var/log/elicita-borme.log 2>&1
set -Eeuo pipefail

REPO_API='https://api.github.com/repos/BquantFinance/licitaciones-espana/releases/latest'
RAW_DIR='/var/data/licitaciones/raw'
BORME_DIR='/var/data/licitaciones/data/borme'
MARKER="$BORME_DIR/.release-tag"
LOG_TAG="[$(date -u +%FT%TZ)]"

log() { echo "$LOG_TAG $*"; }

fail() { log "ERROR: $*"; exit 1; }

mkdir -p "$RAW_DIR" "$BORME_DIR"

latest=$(curl -sf --max-time 60 "$REPO_API" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name",""))' 2>/dev/null) \
  || fail "no se pudo consultar la API de releases"
[ -n "$latest" ] || fail "tag de release vacío"

current=$(cat "$MARKER" 2>/dev/null || echo 'ninguno')
if [ "$latest" = "$current" ]; then
  log "sin cambios (release $latest ya descargado)"
  exit 0
fi

log "release nuevo: $latest (descargado: $current) — descargando borme.zip…"

# Descarga atómica (.part + mv) con reintentos; ~800 MB según release.
ZIP_PART="$RAW_DIR/borme.zip.part"
ZIP="$RAW_DIR/borme-${latest}.zip"
curl -fL --retry 3 --max-time 3600 --retry-delay 10 -o "$ZIP_PART" \
  "https://github.com/BquantFinance/licitaciones-espana/releases/download/${latest}/borme.zip" \
  || fail "descarga de borme.zip falló"
mv "$ZIP_PART" "$ZIP"

# Verificación SHA256 contra el SHA256SUMS.txt del propio release.
sums=$(curl -sf --max-time 60 \
  "https://github.com/BquantFinance/licitaciones-espana/releases/download/${latest}/SHA256SUMS.txt") \
  || log "AVISO: SHA256SUMS.txt no disponible — saltando verificación"
if [ -n "${sums:-}" ]; then
  expected=$(printf '%s\n' "$sums" | awk '$2 ~ /borme\.zip$/ {print $1}')
  actual=$(sha256sum "$ZIP" | awk '{print $1}')
  if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
    fail "SHA256 no coincide (esperado $expected, real $actual)"
  fi
  log "SHA256 verificado (${actual:0:16}…)"
fi

# Extracción a un dir temporal y swap — nunca borra los parquets buenos si la
# extracción falla.
TMP_DIR=$(mktemp -d "$BORME_DIR/.fetch.XXXXXX")
unzip -o -q "$ZIP" -d "$TMP_DIR" || { rm -rf "$TMP_DIR"; fail "unzip falló"; }
[ -f "$TMP_DIR/borme_empresas_pub.parquet" ] && [ -f "$TMP_DIR/borme_cargos_pub.parquet" ] \
  || { rm -rf "$TMP_DIR"; fail "el zip no contiene los parquets esperados"; }

mv "$TMP_DIR/borme_empresas_pub.parquet" "$TMP_DIR/borme_cargos_pub.parquet" "$BORME_DIR/"
# Ficheros informativos del release (LEEME.txt, MANIFEST.csv, etc.)
for f in "$TMP_DIR"/*; do
  base=$(basename "$f")
  case "$base" in
    borme_empresas_pub.parquet|borme_cargos_pub.parquet) ;;
    *) mv "$f" "$BORME_DIR/" 2>/dev/null || true ;;
  esac
done
rm -rf "$TMP_DIR"

printf '%s' "$latest" > "$MARKER"
log "✅ release $latest extraído en $BORME_DIR — el próximo ciclo de materialización lo carga"
