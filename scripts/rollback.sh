#!/usr/bin/env bash
# rollback.sh — Revierte /srv/elicita/web/dist al release anterior (o uno dado).
# Uso: ./scripts/rollback.sh [--yes] [YYYYMMDDHHMMSS]
#   --yes        no pide confirmación (para uso no interactivo)
#   [timestamp]  restaura ese release concreto; sin él, el anterior al actual
set -euo pipefail

REL=/var/data/elicita-releases
DIST=/srv/elicita/web/dist
ORIGIN=https://elicita.es
ASSUME_YES=false
TARGET=""

for a in "$@"; do
  case "$a" in
    --yes) ASSUME_YES=true ;;
    -h|--help) echo "Uso: $0 [--yes] [YYYYMMDDHHMMSS]"; exit 0 ;;
    *) TARGET="$a" ;;
  esac
done

[ -d "$REL" ] || { echo "ERROR: no existe $REL"; exit 1; }
CUR=$(basename "$(readlink -f "$REL/current")")
mapfile -t RELEASES < <(ls -1t "$REL" | grep -E '^[0-9]{14}$')

PREV=""
if [ -n "$TARGET" ]; then
  [ -d "$REL/$TARGET" ] || { echo "ERROR: no existe el release $TARGET"; exit 1; }
  PREV="$TARGET"
else
  for i in "${!RELEASES[@]}"; do
    if [ "${RELEASES[$i]}" = "$CUR" ] && [ "$i" -lt $(( ${#RELEASES[@]} - 1 )) ]; then
      PREV="${RELEASES[$((i+1))]}"
      break
    fi
  done
  [ -n "$PREV" ] || { echo "No hay release anterior a $CUR"; exit 1; }
fi

if [ "$ASSUME_YES" != true ]; then
  read -r -p "Rollback $CUR → $PREV (reinicia elicita). ¿Continuar? [y/N] " r
  [[ "${r:-}" =~ ^[Yy]$ ]] || { echo "Cancelado"; exit 1; }
fi

echo "Restaurando $PREV → $DIST ..."
rsync -a --delete "$REL/$PREV/" "$DIST/"
ln -sfn "$REL/$PREV" "$REL/current"
pm2 restart elicita >/dev/null
sleep 4

FAIL=0
for p in / /api/health; do
  code=$(curl -ksS -o /dev/null -w '%{http_code}' --max-time 10 --resolve elicita.es:443:127.0.0.1 "$ORIGIN$p" 2>/dev/null) || code=000
  echo "$p → $code"
  [[ "$code" =~ ^(200|301|302)$ ]] || FAIL=1
done

if [ "$FAIL" -eq 0 ]; then
  echo "Rollback OK: producción en $PREV"
else
  echo "ATENCIÓN: smoke falló tras el rollback — revisar pm2 logs elicita"
  exit 2
fi
