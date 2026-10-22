#!/bin/bash
# check-dataset-update.sh — Comprueba si hay nueva versión del dataset BquantFinance/licitaciones-espana
# Si la hay, descarga y recarga el DuckDB.
# Uso: bash check-dataset-update.sh [--force]
# Cron: 0 4 * * * /root/.openclaw/workspace/projects/elicita/ingesta/scripts/check-dataset-update.sh

set -euo pipefail

REPO="BquantFinance/licitaciones-espana"
RAW_DIR="/var/data/licitaciones/raw"
LOAD_SCRIPT="/var/data/licitaciones/scripts/load.py"
VERSION_FILE="/var/data/licitaciones/.installed_version"
LOG_FILE="/var/log/elicita-dataset-update.log"
FORCE="${1:-}"

log() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" | tee -a "$LOG_FILE"
}

log "=== Comprobando actualizaciones de dataset ==="

# --- 1. Obtener última versión disponible ---
LATEST_JSON=$(curl -s --max-time 15 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null)
LATEST_TAG=$(echo "$LATEST_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tag_name',''))" 2>/dev/null)
LATEST_DATE=$(echo "$LATEST_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('published_at','')[:10])" 2>/dev/null)

if [ -z "$LATEST_TAG" ]; then
  log "ERROR: No se pudo obtener versión del repositorio GitHub"
  exit 1
fi

log "Última versión disponible: $LATEST_TAG (publicada $LATEST_DATE)"

# --- 2. Comparar con versión instalada ---
INSTALLED_TAG=""
if [ -f "$VERSION_FILE" ]; then
  INSTALLED_TAG=$(cat "$VERSION_FILE")
fi

log "Versión instalada: ${INSTALLED_TAG:-ninguna}"

if [ "$LATEST_TAG" = "$INSTALLED_TAG" ] && [ "$FORCE" != "--force" ]; then
  log "Dataset actualizado. Sin acción necesaria."
  exit 0
fi

log "Nueva versión disponible: $LATEST_TAG — iniciando actualización..."

# --- 3. Descargar assets (solo los que han cambiado) ---
# Lista de assets del release
ASSETS=$(echo "$LATEST_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for a in d.get('assets',[]):
    print(a['name'], a['browser_download_url'])
" 2>/dev/null)

mkdir -p "$RAW_DIR"

echo "$ASSETS" | while read -r FILENAME URL; do
  DEST="$RAW_DIR/$FILENAME"
  if [ -f "$DEST" ] && [ "$FORCE" != "--force" ]; then
    log "  Omitiendo $FILENAME (ya existe)"
  else
    log "  Descargando $FILENAME..."
    curl -L --max-time 3600 --retry 3 -o "$DEST.tmp" "$URL" 2>/dev/null
    mv "$DEST.tmp" "$DEST"
    log "  ✓ $FILENAME descargado"
  fi
done

# --- 4. Recargar DuckDB ---
log "Recargando DuckDB con nuevos datos..."
cd /var/data/licitaciones
python3 "$LOAD_SCRIPT" 2>&1 | tee -a "$LOG_FILE"
log "✓ DuckDB recargado"

# --- 5. Marcar versión instalada ---
echo "$LATEST_TAG" > "$VERSION_FILE"
log "✓ Versión instalada marcada: $LATEST_TAG"

# --- 6. Actualizar contador en la home de elicita ---
# El LiveCounter usa valores hardcodeados — actualizarlos automáticamente
TOTAL=$(python3 -c "
import duckdb
con = duckdb.connect('/var/data/licitaciones/db/licitaciones.duckdb', read_only=True)
result = con.execute('SELECT COUNT(*) FROM licitaciones').fetchone()
print(result[0])
" 2>/dev/null || echo "")

if [ -n "$TOTAL" ]; then
  TOTAL_M=$(python3 -c "print(f'{int(\"$TOTAL\")/1e6:.1f}')" 2>/dev/null)
  log "Total registros en DuckDB: $TOTAL (${TOTAL_M}M)"
fi

log "=== Actualización completada: $LATEST_TAG ==="
