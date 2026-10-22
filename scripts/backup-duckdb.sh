#!/usr/bin/env bash
# backup-duckdb.sh — backup de los DuckDB de producción de elicita
# (propuestas 2026-10-07 C · generalizado a multi-base por la tarea 37,
#  propuesta B de propuestas-2026-10-13-1600)
#
# Cadena: cron (domingo 05:00 UTC) → por base: espera de estabilidad del
#         fichero (mtime antiguo) → copia a .part + chequeo de tamaño EXACTO
#         (base y, si procede, .wal) → mv atómico → rotación N=1 POR BASE →
#         verificación de restauración read-only con conteo exacto
#         (scripts/verifica-backup.py).
#
# Bases:
#   1. licitaciones.duckdb (8+ GB, fichero único: la promoción candidato→DB es
#      atómica y el fichero es estable entre ciclos).
#   2. web-state.duckdb (estado de producto: api_keys, alertas, usage, matching,
#      perfiles, ia_resumenes) CON su .wal — lección del WAL huérfano del
#      01-10: el par base+WAL se copia y se restaura JUNTO; nunca dejar un
#      .wal sin su base ni viceversa. Si el tamaño del .wal cambia durante la
#      copia (checkpoint del writer), el chequeo de tamaño exacto aborta.
#
# NOTA: destino en el MISMO volumen (único disco del servidor) — protege de
# borrado accidental, corrupción post-promoción y error humano, NO de fallo del
# volumen. Destino remoto (rsync a otro nodo) pendiente de decisión de Chema.
#
# Nota de conteo: la referencia se captura ANTES de la copia; una escritura
# viva entre referencia y copia (raro: ventana de estabilidad previa) hace
# fallar la verificación a propósito — el backup sale en rojo y el cron alerta,
# nunca se da por bueno un backup con conteo divergente.
#
# Ficheros: /var/backups/licitaciones/{licitaciones,web-state}.*.duckdb[.wal]
#           (separación por nombre; el directorio de rescate web-state-20261013/
#           no casa con los globs de rotación)
# Log:      /var/log/elicita-backup.log

set -uo pipefail
export PATH="/root/.nvm/versions/node/v26.2.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO=/root/.openclaw/workspace/projects/elicita
KEEP=1  # 15-10: con el snapshot de Hetzner como recuperación a nivel de volumen, el local se mantiene al mínimo (1 = restauración granular rápida sin descargar de Hetzner). Antes: 3.
STABLE_S=300
MAX_WAIT_S=$((20 * 60))
BACKUP_DIR=/var/backups/licitaciones

log() { echo "$(date -u +%FT%TZ) [backup-duckdb] $*"; }
FAILURES=0

# backup_one SRC DIR NAME TABLE WITH_WAL
backup_one() {
  local SRC="$1" DIR="$2" NAME="$3" TABLE="$4" WITH_WAL="$5"
  local SRC_WAL="${SRC}.wal"
  local DEST_WAL DEST part_wal_needed

  [ -f "$SRC" ] || { log "FALLO [$NAME]: no existe $SRC"; FAILURES=$((FAILURES + 1)); return 1; }
  mkdir -p "$DIR"

  # Conteo de referencia ANTES de la copia: la copia debe ser idéntica a este instante.
  local ref_count
  ref_count=$(python3 -c "
import duckdb
con = duckdb.connect('$SRC', read_only=True)
print(con.execute('SELECT COUNT(*) FROM $TABLE').fetchone()[0])
") || { log "FALLO [$NAME]: no se pudo abrir la DB read-only"; FAILURES=$((FAILURES + 1)); return 1; }
  log "[$NAME] count referencia ($TABLE): $ref_count"

  # Espera de estabilidad: sin promoción/escritura reciente (mtime con edad >= STABLE_S)
  local waited=0 age
  while [ "$waited" -lt "$MAX_WAIT_S" ]; do
    age=$(( $(date +%s) - $(stat -c %Y "$SRC") ))
    [ "$age" -ge "$STABLE_S" ] && break
    sleep 60
    waited=$((waited + 60))
  done
  age=$(( $(date +%s) - $(stat -c %Y "$SRC") ))
  log "[$NAME] edad del fichero: ${age}s (esperados ${waited}s)"

  DEST="$DIR/$NAME.$(date -u +%Y%m%d).duckdb"

  # Guard anti-copia-parcial: un backup de hoy solo cuenta si base (y wal)
  # son byte-idénticos en tamaño al origen, y el par es coherente.
  local completo=1
  if [ ! -f "$DEST" ] || [ "$(stat -c %s "$DEST")" != "$(stat -c %s "$SRC")" ]; then
    completo=0
  fi
  if [ "$completo" = "1" ] && [ "$WITH_WAL" = "1" ]; then
    if [ -f "$SRC_WAL" ]; then
      { [ -f "$DEST.wal" ] && [ "$(stat -c %s "$DEST.wal")" = "$(stat -c %s "$SRC_WAL")" ]; } || completo=0
    else
      [ -f "$DEST.wal" ] && completo=0
    fi
  fi

  local nueva=1
  if [ "$completo" = "1" ]; then
    log "[$NAME] backup de hoy ya existe y está completo ($DEST) — omitido"
    nueva=0
  else
    rm -f -- "$DEST" "$DEST.wal" "$DEST.part" "$DEST.part.wal"
    cp "$SRC" "$DEST.part" || { log "FALLO [$NAME]: cp falló"; rm -f -- "$DEST.part"; FAILURES=$((FAILURES + 1)); return 1; }
    if [ "$(stat -c %s "$DEST.part")" != "$(stat -c %s "$SRC")" ]; then
      log "FALLO [$NAME]: copia incompleta ($(stat -c %s "$DEST.part") de $(stat -c %s "$SRC") bytes)"
      rm -f -- "$DEST.part"
      FAILURES=$((FAILURES + 1))
      return 1
    fi
    part_wal_needed=0
    if [ "$WITH_WAL" = "1" ] && [ -f "$SRC_WAL" ]; then
      cp "$SRC_WAL" "$DEST.part.wal" || { log "FALLO [$NAME]: cp del wal falló"; rm -f -- "$DEST.part" "$DEST.part.wal"; FAILURES=$((FAILURES + 1)); return 1; }
      if [ "$(stat -c %s "$DEST.part.wal")" != "$(stat -c %s "$SRC_WAL")" ]; then
        log "FALLO [$NAME]: copia del wal incompleta"
        rm -f -- "$DEST.part" "$DEST.part.wal"
        FAILURES=$((FAILURES + 1))
        return 1
      fi
      part_wal_needed=1
    fi
    # mv del par (wal primero, base después): la verificación solo corre con
    # el par completo en su sitio; un crash entre ambos deja .part y el
    # siguiente ciclo lo sobreescribe.
    if [ "$part_wal_needed" = "1" ]; then mv "$DEST.part.wal" "$DEST.wal"; fi
    mv "$DEST.part" "$DEST"
    log "[$NAME] copia completada y atómica: $DEST ($(du -h "$DEST" | cut -f1))$( [ -f "$DEST.wal" ] && echo " + wal ($(du -h "$DEST.wal" | cut -f1))" )"
  fi

  # Rotación N=3 POR BASE (siempre DESPUÉS de que la copia nueva exista)
  ls -1t "$DIR"/"$NAME".*.duckdb 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    log "[$NAME] rotación: borro $old"
    rm -f -- "$old" "${old}.wal"
  done

  # Verificación de restauración (solo en copia nueva; una ya existente ya se verificó en su día)
  if [ "$nueva" -eq 1 ]; then
    python3 "$REPO/scripts/verifica-backup.py" "$DEST" "$ref_count" "$TABLE" \
      || { log "FALLO [$NAME]: verificación de restauración en rojo"; FAILURES=$((FAILURES + 1)); return 1; }
  fi
  log "[$NAME] OK"
  return 0
}

# Nota: backup_one lleva su propio conteo de fallos en FAILURES (global); las
# llamadas de abajo no suman doble (|| true).
backup_one /var/data/licitaciones/db/licitaciones.duckdb "$BACKUP_DIR" licitaciones calidad 0 || true
backup_one /var/data/licitaciones/db/web-state.duckdb "$BACKUP_DIR" web-state ia_resumenes 1 || true

if [ "$FAILURES" -gt 0 ]; then
  log "FALLO: $FAILURES base(s) en rojo"
  exit 1
fi
log "backup-duckdb OK"
