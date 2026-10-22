#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/root/.openclaw/workspace/projects/elicita
LIVE_DB=/var/data/licitaciones/db/licitaciones.duckdb
DB_DIR=$(dirname "$LIVE_DB")
BACKUP_DIR=/var/backups/elicita/materialization
LOCK_FILE=/run/lock/elicita-materialization.lock
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
CANDIDATE_DB="$DB_DIR/licitaciones.${STAMP}.candidate.duckdb"
ROLLBACK_DB="$BACKUP_DIR/licitaciones-pre-latest.duckdb"
LOG_FILE=/var/log/elicita-materialization.log
consumers_stopped=0

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date -u +%FT%TZ)] SKIP: materialization already running" >> "$LOG_FILE"
  exit 0
fi

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG_FILE"; }
start_consumers() {
  if (( consumers_stopped )); then
    pm2 start elicita elicita-mcp >/dev/null
    consumers_stopped=0
  fi
}
cleanup() {
  status=$?
  start_consumers || true
  if (( status != 0 )); then
    rm -f -- "$CANDIDATE_DB"
    log "FAILED status=$status"
  fi
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"
log "START candidate=$CANDIDATE_DB"

# La DB viva solo cambia por promociones atómicas (rename): entre ciclos el
# fichero es estable, así que el cp del candidato es un snapshot consistente
# SIN parar lectores (mismo patrón verificado en scripts/backup-duckdb.sh).
# Espera a que asiente la promoción previa (mtime >= 120s) y verifica tamaño;
# si el cp sale distinto, reintenta con lectores parados (camino seguro).
waited=0
age=0
while [ "$waited" -lt 900 ]; do
  age=$(( $(date +%s) - $(stat -c %Y "$LIVE_DB") ))
  if [ "$age" -ge 120 ]; then break; fi
  sleep 30
  waited=$((waited + 30))
done
log "cp del candidato sin parar lectores (edad del fichero: ${age}s)"
cp --reflink=auto --sparse=always "$LIVE_DB" "$CANDIDATE_DB"
if [ "$(stat -c %s "$CANDIDATE_DB")" != "$(stat -c %s "$LIVE_DB")" ]; then
  log "WARNING: cp del candidato distinto ($(stat -c %s "$CANDIDATE_DB") vs $(stat -c %s "$LIVE_DB")) — reintentando con lectores parados"
  pm2 stop elicita elicita-mcp >/dev/null
  consumers_stopped=1
  rm -f -- "$CANDIDATE_DB"
  cp --reflink=auto --sparse=always "$LIVE_DB" "$CANDIDATE_DB"
  if [ "$(stat -c %s "$CANDIDATE_DB")" != "$(stat -c %s "$LIVE_DB")" ]; then
    log "ERROR: cp del candidato falla incluso con lectores parados"
    exit 1
  fi
  start_consumers
fi

DUCKDB_PATH="$CANDIDATE_DB" \
ELICITA_LOAD_LOG="$LOG_FILE" \
python3 "$ROOT/ingesta/scripts/load-json-to-duckdb.py"

# BORME incremental (fase 0 del plan BORME 2026-10-14): recarga de parquet
# del release upstream + catch-up XML diario de boe.es, SIEMPRE sobre el
# candidato (nunca sobre la BD live). No fatal: un fallo de BORME no bloquea
# la promoción de contratación.
log "BORME incremental (parquet + XML diario)"
DUCKDB_PATH="$CANDIDATE_DB" \
  BORME_DIR="${BORME_DIR:-/var/data/licitaciones/data/borme}" \
  BORME_XML_DIR="${BORME_XML_DIR:-/var/data/licitaciones/data/borme-xml}" \
  python3 "$ROOT/ingesta/scripts/load-borme-incremental.py" \
  || log "WARNING: BORME incremental falló (no fatal) — contratación sigue"

CANDIDATE_DB="$CANDIDATE_DB" LIVE_DB="$LIVE_DB" \
python3 "$ROOT/ingesta/scripts/validate-materialization.py"

# Promoción atómica con una única copia de rollback. Los procesos deben reabrir
# el inode nuevo, por eso se reinician alrededor del rename.
pm2 stop elicita elicita-mcp >/dev/null
consumers_stopped=1
rm -f -- "$ROLLBACK_DB"
mv "$LIVE_DB" "$ROLLBACK_DB"
mv "$CANDIDATE_DB" "$LIVE_DB"
chown --reference="$ROLLBACK_DB" "$LIVE_DB"
chmod --reference="$ROLLBACK_DB" "$LIVE_DB"
start_consumers

log "SUCCESS live=$(stat -c %s "$LIVE_DB") rollback=$(stat -c %s "$ROLLBACK_DB")"

# Liberar el inode viejo: el scheduler mantiene conexiones DuckDB abiertas que
# pinnan el rollback ya borrado (~7,6 GB retenidos por ciclo hasta reiniciar).
( sleep 10; pm2 restart elicita-scheduler ) >/dev/null 2>&1 &
