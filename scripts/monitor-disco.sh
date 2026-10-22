#!/usr/bin/env bash
# monitor-disco.sh — vigilante de disco del servidor elicita (backlog tarea 25)
#
# Uso: monitor-disco.sh [umbral] [--json]
#   umbral   % de uso que se considera alerta (default 85)
#   --json   salida JSON para el trigger del watcher (siempre exit 0 si hay salida)
#
# Exit codes (modo humano): 0 = todo bajo el umbral · 1 = alguna partición >= umbral · 3 = error
# En modo --json el exit es siempre 0 (con salida parseable) o 3 (sin salida);
# el estado de alerta viaja en el JSON ("ok": true/false), no en el exit code.
#
# Copia estable en producción: /root/scripts/monitor-disco.sh
# El watcher del Gateway llama SIEMPRE a la copia estable (resistente a cambios de rama).
# Si se edita este fichero, actualizar la copia con:
#   cp scripts/monitor-disco.sh /root/scripts/monitor-disco.sh
#
# Origen: docs/plans/backlog-mejora-continua.md tarea 25 — el ENOSPC del 2026-09-28
# (18:56 UTC) tiró 6 webs y mató el backfill BOE sin que nadie viera llegar el disco.

set -uo pipefail

THRESHOLD=85
JSON=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    [0-9]*) THRESHOLD="$arg" ;;
    *) echo "uso: $0 [umbral] [--json]" >&2; exit 3 ;;
  esac
done

DF_OUT="$(df -P -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2)"
if [[ -z "$DF_OUT" ]]; then
  if [[ "$JSON" == "1" ]]; then
    echo "{\"threshold\":${THRESHOLD},\"error\":\"df sin salida util\"}"
    exit 0
  fi
  echo "monitor-disco: ERROR df sin salida util" >&2
  exit 3
fi

OUT="$(python3 - "$THRESHOLD" "$DF_OUT" <<'PY'
import json, sys
threshold = int(sys.argv[1])
mounts, over = [], []
for line in sys.argv[2].strip().splitlines():
    parts = line.split()
    if len(parts) < 6:
        continue
    try:
        pct = int(parts[4].rstrip('%'))
    except ValueError:
        continue
    mounts.append({"fs": parts[0], "mount": parts[5], "use_pct": pct})
    if pct >= threshold:
        over.append("%s %d%%" % (parts[5], pct))
print(json.dumps({"threshold": threshold, "mounts": mounts, "over": over, "ok": not over}))
sys.exit(1 if over else 0)
PY
)"
RC=$?

if [[ "$JSON" == "1" ]]; then
  echo "$OUT"
  exit 0
fi

echo "monitor-disco: umbral ${THRESHOLD}%"
echo "$DF_OUT" | awk '{printf "  %-28s %s\n", $6, $5}'
if [[ $RC -eq 1 ]]; then
  echo "ALERTA: particiones sobre el umbral"
else
  echo "OK: sin particiones sobre el umbral"
fi
exit $RC
