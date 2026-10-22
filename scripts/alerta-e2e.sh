#!/usr/bin/env bash
# alerta-e2e.sh — E2E de caminos críticos 1×/día contra el origen (propuestas 2026-10-21, B)
#
# Cadena: cron → este wrapper → scripts/e2e-caminos.mjs http://localhost:4321 (3 caminos:
#         buscar con interacción real, perfil URDINBERRI, ficha FARO) →
#         si exit != 0 → re-verificación a los 60s (un reinicio breve del web durante un
#         deploy es esperado) → si sigue fallando → `openclaw agent` dispara turno que
#         compone la alerta y la entrega por Telegram. Dedup 6h; aviso RECUPERADO a verde.
#
# Por qué existe: el smoke HTTP (alerta-web.sh, 15 min) es ciego al JS de cliente — la clase
# P0 «bundle JS muerto servido» (caso real 12-10: buscar sin resultados por ReferenceError
# en el bundle con smoke verde) solo la cazó el E2E de la tarea 27. Este vigilante detecta
# esa clase en <24h contra el MISMO proceso PM2 que sirve producción (mismo dist).
#
# Cadencia deliberada 1×/día (NO cada 6h): el camino 1 consume 1 búsqueda del bucket local
# 127.0.0.1 de /api/public/search (3/día por IP) — 1/día deja margen. NO correr contra
# https://elicita.es: quema el bucket del origen y lo advierte el header del propio E2E.
#
# Override de test (umbral forzado):
#   E2E_CMD='node /root/.openclaw/workspace/projects/elicita/scripts/e2e-caminos.mjs http://127.0.0.1:9' ./alerta-e2e.sh
#
# Ficheros: estado /tmp/elicita-alerta-e2e.estado · mensaje /tmp/elicita-alerta-e2e.mensaje.txt
# Log:      /var/log/elicita-e2e-alerta.log

set -uo pipefail
export PATH="/root/.nvm/versions/node/v26.2.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO=/root/.openclaw/workspace/projects/elicita
# Target localhost (NO 127.0.0.1, desviación de la spec documentada): desde el 21-10 ~14:44
# el proceso PM2 escucha SOLO en [::1]:4321 (HOST=localhost → IPv6; decisión de fix pendiente
# de Chema, documentada por el vigilante web en syslog). localhost resuelve al listener
# activo en AMBAS configuraciones (IPv6-only hoy; 127.0.0.1 tras el fix) — siempre el MISMO
# proceso PM2 que sirve producción.
E2E_CMD="${E2E_CMD:-node $REPO/scripts/e2e-caminos.mjs http://localhost:4321}"
REPEAT_S=$((6 * 3600))
RETRY_WAIT_S=60
STATE=/tmp/elicita-alerta-e2e.estado
MSGFILE=/tmp/elicita-alerta-e2e.mensaje.txt
TELEGRAM_TO=5804565
SESSION_KEY="agent:main:watchdog-e2e"

out=$($E2E_CMD 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "$(date -u +%FT%TZ) e2e rc=$rc — re-verificando en ${RETRY_WAIT_S}s antes de alertar"
  sleep "$RETRY_WAIT_S"
  out=$($E2E_CMD 2>&1)
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
  echo "$(date -u +%FT%TZ) ALERTA: E2E rc=$rc tras re-verificación — disparando turno agente (dedup 6h)"

  fallos=$(echo "$out" | tail -12)

  cat > "$MSGFILE" <<EOF
ALERTA automática del E2E diario de elicita (cron 06:47 UTC, propuestas 2026-10-21 B): algún camino crítico falla contra el origen localhost:4321 —el MISMO proceso PM2 que sirve producción— tras re-verificación a los 60s. Salida:
$fallos

Pasos obligatorios:
1) Verifica: pm2 list (elicita) · node /root/.openclaw/workspace/projects/elicita/scripts/e2e-caminos.mjs http://localhost:4321 · tail -30 /var/log/elicita-e2e-alerta.log
   Clase esperada: «bundle JS muerto servido» (caso real 12-10: buscar sin resultados por ReferenceError en el bundle con smoke HTTP verde) — el smoke no puede verla, este E2E sí. Si el fallo es un reinicio breve por deploy en curso, re-verifica a los 60s antes de confirmar.
2) Redacta la alerta final para Chema en español, voz FARO (directa, con datos, cero dramatismo): qué camino falla, cómo (error exacto), impacto y siguiente paso concreto. NO reinicies servicios, no toques PM2 ni borres nada por tu cuenta.
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
    echo "$(date -u +%FT%TZ) RECUPERADO: E2E 3/3 — disparando aviso"
    cat > "$MSGFILE" <<EOF
Aviso automático del E2E diario de elicita: los 3 caminos críticos (buscar con interacción real, perfil, ficha FARO) vuelven a pasar contra el origen. Redacta un aviso breve para Chema (2-3 líneas, español, voz FARO) confirmando la recuperación. Respuesta final = solo el texto.
EOF
    exec openclaw agent --agent main --session-key "$SESSION_KEY" \
      --deliver --channel telegram --reply-to "$TELEGRAM_TO" \
      --message-file "$MSGFILE"
  fi
  exit 0
fi
