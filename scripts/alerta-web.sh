#!/usr/bin/env bash
# alerta-web.sh — smoke SSR de las páginas públicas cada 15 min (propuestas 2026-10-07, B)
#
# Cadena: cron → este wrapper → scripts/smoke.sh https://elicita.es (6 páginas, UA anti-CF) →
#         si exit 1 → re-verificación a los 60s (evita incidentes CF transitorios) →
#         si sigue fallando → `openclaw agent` dispara turno que compone la alerta y
#         la entrega por Telegram. Dedup 6h; aviso RECUPERADO al volver a verde.
# Cubre el hueco del canary /api/stats: en el incidente 29-09 las páginas daban 500 con el API en verde.
#
# Override de test (umbral forzado):
#   SMOKE_CMD='bash /root/.openclaw/workspace/projects/elicita/scripts/smoke.sh http://127.0.0.1:9' ./alerta-web.sh
#
# Ficheros: estado /tmp/elicita-alerta-web.estado · mensaje /tmp/elicita-alerta-web.mensaje.txt
# Log:      /var/log/elicita-web-alerta.log

set -uo pipefail
export PATH="/root/.nvm/versions/node/v26.2.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO=/root/.openclaw/workspace/projects/elicita
SMOKE_CMD="${SMOKE_CMD:-bash $REPO/scripts/smoke.sh https://elicita.es}"
REPEAT_S=$((6 * 3600))
RETRY_WAIT_S=60
STATE=/tmp/elicita-alerta-web.estado
MSGFILE=/tmp/elicita-alerta-web.mensaje.txt
TELEGRAM_TO=5804565
SESSION_KEY="agent:main:watchdog-web"

out=$($SMOKE_CMD 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "$(date -u +%FT%TZ) smoke rc=$rc — re-verificando en ${RETRY_WAIT_S}s antes de alertar"
  sleep "$RETRY_WAIT_S"
  out=$($SMOKE_CMD 2>&1)
  rc=$?
fi

if [ "$rc" -ne 0 ]; then
  now=$(date +%s)
  prev_alerting=0
  prev_ts=0
  if [ -f "$STATE" ]; then read -r prev_alerting prev_ts < "$STATE" 2>/dev/null || true; fi
  if [ "$prev_alerting" = "1" ] && [ $((now - prev_ts)) -lt $REPEAT_S ]; then
    exit 0
  fi
  echo "1 $now" > "$STATE"
  echo "$(date -u +%FT%TZ) ALERTA: smoke SSR rc=$rc tras re-verificación — disparando turno agente (dedup 6h)"

  fallos=$(echo "$out" | tail -10)

  cat > "$MSGFILE" <<EOF
ALERTA automática del smoke SSR de elicita (cron cada 15 min, propuestas 2026-10-07 B): páginas públicas caídas tras re-verificación a los 60s. Fallos:
$fallos

Pasos obligatorios:
1) Verifica estado: pm2 list (elicita) · tail -30 /var/log/elicita-web-alerta.log · curl -s -o /dev/null -w '%{http_code}' https://elicita.es
   NOTA: /root/.openclaw/workspace/projects/elicita es un SYMLINK a /srv/elicita — MISMO repo en dos rutas, diseño intencional. No lo reportes como duplicación ni como causa de incidentes. Un reinicio breve del web durante un deploy es esperado (re-verifica a los 60 s antes de alertar).
2) Redacta la alerta final para Chema en español, voz FARO (directa, con datos, cero dramatismo): qué páginas fallan, cómo (códigos/respuesta), impacto y siguiente paso concreto. NO reinicies servicios, no toques PM2 ni borres nada por tu cuenta.
3) Tu respuesta final se entrega por Telegram: devuelve SOLO el texto del mensaje, sin preámbulos ni preguntas.
EOF
  exec openclaw agent --agent main --session-key "$SESSION_KEY" \
    --deliver --channel telegram --reply-to "$TELEGRAM_TO" \
    --message-file "$MSGFILE"
else
  prev_alerting=0
  if [ -f "$STATE" ]; then read -r prev_alerting _ < "$STATE" 2>/dev/null || true; fi
  if [ "$prev_alerting" = "1" ]; then
    echo "0 0" > "$STATE"
    echo "$(date -u +%FT%TZ) RECUPERADO: smoke SSR 6/6 — disparando aviso"
    cat > "$MSGFILE" <<EOF
Aviso automático del smoke SSR de elicita: las 6 páginas públicas vuelven a responder con el contenido esperado. Redacta un aviso breve para Chema (2-3 líneas, español, voz FARO) confirmando la recuperación. Respuesta final = solo el texto.
EOF
    exec openclaw agent --agent main --session-key "$SESSION_KEY" \
      --deliver --channel telegram --reply-to "$TELEGRAM_TO" \
      --message-file "$MSGFILE"
  fi
  exit 0
fi
