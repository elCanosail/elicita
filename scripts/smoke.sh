#!/usr/bin/env bash
# scripts/smoke.sh — smoke test de las páginas públicas de elicita_
#
# Uso:
#   ./scripts/smoke.sh                        # contra producción (https://elicita.es)
#   ./scripts/smoke.sh http://127.0.0.1:4391  # contra build local (puertos altos, nunca 4321)
#
# GET a las páginas públicas clave + grep del contenido esperado.
# Salida limpia y exit 0 si todo pasa; lista de fallos y exit 1 si algo falla.
#
# Nota: User-Agent de navegador — Cloudflare devuelve 403 al UA por defecto de curl.

set -u

BASE="${1:-https://elicita.es}"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
TIMEOUT=20

failures=()
passed=0

check() {
  local path="$1" needle="$2"
  local body rc
  body=$(curl -fsS --max-time "$TIMEOUT" -A "$UA" "$BASE$path" 2>/dev/null)
  rc=$?
  if [ $rc -ne 0 ]; then
    failures+=("GET $BASE$path → curl exit $rc (HTTP != 200 o sin respuesta)")
    return 1
  fi
  if ! grep -q "$needle" <<<"$body"; then
    failures+=("$path → HTTP 200 pero sin contenido esperado: «$needle»")
    return 1
  fi
  passed=$((passed + 1))
  echo "  ✓ $path"
}

echo "Smoke test elicita_ → $BASE"
echo "----------------------------------------------------------------"

check "/"                  "contratación pública"
check "/cobertura"         "fuentes oficiales"
check "/docs/metodologia"  "Normalización"
check "/fuentes"           "fuentes oficiales"
check "/estadisticas"      "contratación pública"
check "/datos-abiertos"    "Datos abiertos"

echo "----------------------------------------------------------------"
if [ ${#failures[@]} -eq 0 ]; then
  echo "OK: $passed/$passed páginas correctas"
  exit 0
fi

echo "FALLOS (${#failures[@]}):"
printf '  ✗ %s\n' "${failures[@]}"
echo "Fallan ${#failures[@]} de $((passed + ${#failures[@]})) comprobaciones"
exit 1
