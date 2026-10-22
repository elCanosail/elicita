#!/usr/bin/env bash
# alerta-calidad.sh — wrapper cron del monitor de calidad de elicita (propuestas 2026-10-07, A)
#
# Cadena: cron (cada 4 min) → este wrapper → data_quality_monitor.py →
#         si exit 1 → `openclaw agent` dispara un turno que compone la alerta y
#         la entrega por Telegram (--deliver --reply-to). Dedup 6h mientras siga
#         fallando; aviso RECUPERADO al volver a verde.
# El output del monitor se anexa a /var/log/elicita-quality.log (log histórico intacto).
#
# Override de test (umbral forzado sin tocar producción):
#   MONITOR_CMD='sh -c "echo [TEST] [WEB] /api/stats no responde: Connection refused; exit 1"' \
#     ./alerta-calidad.sh
#
# Ficheros: estado /tmp/elicita-alerta-calidad.estado · mensaje /tmp/elicita-alerta-calidad.mensaje.txt
# Log:      /var/log/elicita-calidad-alerta.log (wrapper) · /var/log/elicita-quality.log (monitor)
# Origen:   episodio 2026-10-07 04:56 UTC — /api/stats caída + 4 checks en rojo, nadie lo supo.

set -uo pipefail
export PATH="/root/.nvm/versions/node/v26.2.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO=/root/.openclaw/workspace/projects/elicita
MONITOR_CMD="${MONITOR_CMD:-/usr/bin/python3 $REPO/ingesta/scripts/data_quality_monitor.py}"
REPEAT_S=$((6 * 3600))
STATE=/tmp/elicita-alerta-calidad.estado
MSGFILE=/tmp/elicita-alerta-calidad.mensaje.txt
TELEGRAM_TO=5804565
SESSION_KEY="agent:main:watchdog-calidad"
LOG_QUALITY=/var/log/elicita-quality.log
STATUS_JSON="$REPO/ingesta/data/status.json"
HEALTH_JSON="$REPO/ingesta/data/connector_health.json"

out=$($MONITOR_CMD 2>&1)
rc=$?
echo "$(date -u +%FT%TZ) monitor rc=$rc" >> "$LOG_QUALITY"
[ -n "$out" ] && echo "$out" >> "$LOG_QUALITY"

# Tolerancia a colisiones (07-10): el web se reinicia en dos ventanas por ciclo de
# materialización (cp del candidato y promoción) y el cron fijo de 4 min pega
# dentro de ellas → falsos rojos periódicos. Un rojo se re-verifica a los 75s:
# solo alerta si sigue rojo.
if [ "$rc" -ne 0 ]; then
  echo "$(date -u +%FT%TZ) TRANSITORIO?: roja (rc=1) — re-verificando en 75s antes de alertar"
  sleep 75
  out=$($MONITOR_CMD 2>&1)
  rc=$?
  echo "$(date -u +%FT%TZ) re-verificación rc=$rc" >> "$LOG_QUALITY"
  [ -n "$out" ] && echo "$out" >> "$LOG_QUALITY"
  if [ "$rc" -eq 0 ]; then
    echo "$(date -u +%FT%TZ) TRANSITORIO resuelto: verde al reintento — sin alerta"
  fi
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
  echo "$(date -u +%FT%TZ) ALERTA: monitor de calidad rc=$rc — disparando turno agente (dedup 6h)"

  status_summary=$(python3 -c "
import json
try:
    s = json.load(open('$STATUS_JSON'))
    print('status.json: connectors_ok=%s connectors_error=%s' % (s.get('connectors_ok','?'), s.get('connectors_error','?')))
except Exception as e:
    print('status.json no legible: %s' % e)
try:
    h = json.load(open('$HEALTH_JSON'))
    parts = ['%s: runs=%s' % (k, v.get('total_runs','?')) for k, v in h.items() if isinstance(v, dict)]
    print('connector_health: ' + ', '.join(parts[:8]))
except Exception as e:
    print('connector_health no legible: %s' % e)
" 2>/dev/null)

  problemas=$(echo "$out" | grep -E "^\[|no responde|fallo|ERROR" | head -8)
  [ -z "$problemas" ] && problemas=$(echo "$out" | tail -8)

  cat > "$MSGFILE" <<EOF
ALERTA automática del monitor de calidad de elicita (cron cada 4 min, propuestas 2026-10-07 A). El monitor terminó con fallo. Problemas detectados:
$problemas

$status_summary

Pasos obligatorios:
1) Verifica estado: pm2 list · curl -s --max-time 8 http://127.0.0.1:4321/api/stats | head -c 200 · tail -30 /var/log/elicita-quality.log · tail -20 /var/log/elicita-materialization.log
   NOTA: /root/.openclaw/workspace/projects/elicita es un SYMLINK a /srv/elicita — MISMO repo en dos rutas, diseño intencional. No lo reportes como duplicación ni como causa de incidentes. Un reinicio breve del web durante un deploy es esperado (re-verifica a los 75 s antes de alertar).
2) Redacta la alerta final para Chema en español, voz FARO (directa, con datos, cero dramatismo): qué falla, desde cuándo (por timestamps del log), impacto probable y siguiente paso concreto. NO reinicies servicios, no toques PM2 ni /var/data, no borres nada por tu cuenta.
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
    echo "$(date -u +%FT%TZ) RECUPERADO: monitor de calidad en verde — disparando aviso"
    cat > "$MSGFILE" <<EOF
Aviso automático del monitor de calidad de elicita: el monitor volvió a verde (todas las reglas OK). Redacta un aviso breve para Chema (2-3 líneas, español, voz FARO) confirmando la recuperación con los datos del monitor. Respuesta final = solo el texto.
EOF
    exec openclaw agent --agent main --session-key "$SESSION_KEY" \
      --deliver --channel telegram --reply-to "$TELEGRAM_TO" \
      --message-file "$MSGFILE"
  fi
  exit 0
fi
