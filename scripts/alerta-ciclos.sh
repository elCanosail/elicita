#!/usr/bin/env bash
# alerta-ciclos.sh — vigilante de los ciclos dirigidos a usuarios de elicita (tarea 43 backlog)
#
# Cadena: cron → este wrapper (subcomando) → check del log vivo → si condición de alerta →
#         `openclaw agent` compone y entrega la alerta por Telegram (--deliver).
# Patrón: alerta-disco.sh (tarea 25) — estado en /tmp, dedup, RECUPERADO, entrega vía agente.
#
# Subcomandos:
#   reporte  — lunes 08:30 UTC (cron): la línea [REPORTE] de hoy debe existir en el
#              scheduler-out.log y no contener «Error» ni «errores N» con N>0
#              (éxito verificado en ingesta/scheduler.js:270 → «[REPORTE] Enviados N, errores M»).
#              Sin línea = el ciclo no firingó o el scheduler está muerto.
#   alertas  — :40 cada 4h (cron): la línea [ALERTAS] de la ventana (últimos 75 min,
#              ciclo de :30) debe existir; «errores K» con K>0 alerta solo SOSTENIDO
#              2 ciclos seguidos (no gritar por un fallo puntual). Línea ausente en
#              ventana = scheduler muerto → alerta inmediata.
#              Formato vivo verificado 16-10: «[…T04:30:00.945Z] [ALERTAS] 0 enviados, 0 saltados, 1 errores».
#   borme    — 03:40 UTC diario (cron): sin líneas «ERROR:» de hoy en /var/log/elicita-borme.log
#              Y mtime de /var/data/licitaciones/data/borme/.release-tag < 26h
#              (en días «sin cambios» el tag NO se re-toca: 26h cubre el día sin falso aviso).
#
# Sin tocar scheduler.js, reporte-semanal.js ni alertas-runner.js: este wrapper SOLO LEE logs.
# Entrega: desde cron funciona (lección 07-10); desde exec de sesión la rechaza el gateway.
#
# Env de prueba:
#   ELICITA_CICLOS_FORCE=1   — fuerza la rama de alerta y salta ventanas/dedup; NO escribe estado
#                              (mensaje claramente marcado como TEST; para confirmar el hop cron→Telegram).
#   ELICITA_CICLOS_DRYRUN=1  — imprime el mensaje en stdout en vez de entregar (tests de lógica con fixtures).
#
# Ficheros: fuente en repo elicita scripts/alerta-ciclos.sh · copia estable /root/scripts/
# Log:      /var/log/elicita-ciclos-alerta.log

set -uo pipefail
export PATH="/root/.nvm/versions/node/v26.2.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SCHED_LOG="${ELICITA_SCHED_LOG:-/root/.pm2/logs/elicita-scheduler-out.log}"
BORME_LOG="${ELICITA_BORME_LOG:-/var/log/elicita-borme.log}"
RELEASE_TAG="${ELICITA_BORME_TAG:-/var/data/licitaciones/data/borme/.release-tag}"

TELEGRAM_TO=5804565
SESSION_KEY="agent:main:watchdog-ciclos"
REPEAT_S=$((6 * 3600))       # dedup estándar 6h (borme usa 24h)
REPEAT_S_BORME=$((24 * 3600))
REPEAT_S_ALERTAS=$((24 * 3600))  # alertas de usuario: resumen diario
MSGFILE=/tmp/elicita-ciclos.mensaje.txt
FORCE="${ELICITA_CICLOS_FORCE:-0}"
DRYRUN="${ELICITA_CICLOS_DRYRUN:-0}"

MODE="${1:-}"
TODAY="$(date -u +%F)"
NOW_EPOCH="$(date -u +%s)"

# entrega TITULO — cuerpo del trigger; compone el turno del agente y entrega por Telegram.
entrega() {
  local titulo="$1" cuerpo="$2" testtag=""
  if [[ "$FORCE" == "1" ]]; then testtag="PRUEBA FORZADA del vigilante (tarea 43) — no es una alerta real. "; fi
  cat > "$MSGFILE" <<EOF
${testtag}${titulo}: ${cuerpo}

Redacta la alerta final para Chema en español, voz FARO (directa, con datos, cero dramatismo), 3-6 líneas, citando los datos del trigger y qué comprobar a mano. NO ejecutes acciones: solo redacta. Tu respuesta final se entrega por Telegram: devuelve SOLO el texto del mensaje, sin preámbulos ni preguntas.
EOF
  if [[ "$DRYRUN" == "1" ]]; then
    echo "--- DRYRUN mensaje ($titulo) ---"
    cat "$MSGFILE"
    echo "--- fin DRYRUN ---"
    return 0
  fi
  exec openclaw agent --agent main --session-key "$SESSION_KEY" \
    --deliver --channel telegram --reply-to "$TELEGRAM_TO" \
    --message-file "$MSGFILE"
}

# estado FICHERO alerting ts — lee "alerting ts"; devuelve por stdout "alerting ts"
lee_estado() {
  local f="$1"
  if [[ -f "$f" ]]; then read -r a t < "$f" 2>/dev/null || true; echo "${a:-0} ${t:-0}"; else echo "0 0"; fi
}

# última línea [REPORTE]/[ALERTAS] de HOY en el scheduler-out.log (rotación PM2 diaria 00:00 UTC)
ultima_linea_hoy() {
  local tag="$1"
  grep "\[${TODAY}T.*\] \[${tag}\]" "$SCHED_LOG" 2>/dev/null | tail -1
}

# epoch de la línea «[2026-10-16T04:30:00.945Z] …» — vacío si no parsea
epoch_de_linea() {
  local line="$1" ts
  ts="$(sed -n 's/^\[\([^]]*\)\].*/\1/p' <<<"$line")"
  [[ -z "$ts" ]] && return 0
  date -u -d "$ts" +%s 2>/dev/null || true
}

case "$MODE" in

  reporte)
    STATE=/tmp/elicita-ciclos-reporte.estado
    # ventana lunes 08:05-09:00 UTC (cron 08:30) — FORCE salta la guardia
    if [[ "$FORCE" != "1" ]]; then
      dow="$(date -u +%u)"; hour="$(date -u +%H)"
      [[ "$dow" == "1" && "$hour" == "08" ]] || exit 0
    fi
    line="$(ultima_linea_hoy REPORTE)"
    trigger="$(grep -c "\[${TODAY}T.*\] Cron trigger — reporte semanal" "$SCHED_LOG" 2>/dev/null)"
    trigger="${trigger:-0}"
    read -r prev_alerting prev_ts < <(lee_estado "$STATE")
    now="$NOW_EPOCH"

    cond=""
    if [[ -z "$line" ]]; then
      cond="La línea [REPORTE] de HOY no existe en scheduler-out.log (trigger registrado hoy: ${trigger}). O el ciclo de las 08:00 UTC no firingó o el scheduler está muerto — sin él, los usuarios Pro no reciben el email semanal y nadie se entera."
    elif grep -q "Error:" <<<"$line"; then
      cond="El reporte semanal de hoy FALLÓ: ${line}"
    elif grep -qE "errores [1-9][0-9]*" <<<"$line"; then
      cond="El reporte semanal de hoy terminó con envíos fallidos: ${line} — hay usuarios Pro a los que NO llegó el email de retención."
    fi

    if [[ -n "$cond" ]]; then
      if [[ "$FORCE" != "1" && "$prev_alerting" == "1" && $((now - prev_ts)) -lt $REPEAT_S ]]; then exit 0; fi
      [[ "$FORCE" != "1" ]] && echo "1 $now" > "$STATE"
      echo "$(date -u +%FT%TZ) ALERTA reporte: disparando turno agente (dedup 6h)"
      entrega "Alerta del vigilante de ciclos de elicita (reporte semanal)" "$cond"
    else
      if [[ "$FORCE" != "1" ]]; then echo "0 0" > "$STATE"; fi
      if [[ "$prev_alerting" == "1" ]]; then
        echo "$(date -u +%FT%TZ) RECUPERADO: reporte OK — disparando aviso"
        entrega "Aviso del vigilante de ciclos de elicita (reporte semanal)" "El reporte semanal de hoy terminó bien: ${line}"
      fi
      [[ "$FORCE" == "1" ]] && echo "$(date -u +%FT%TZ) TEST reporte: ciclo OK (${line}) — sin alerta"
      exit 0
    fi
    ;;

  alertas)
    STATE=/tmp/elicita-ciclos-alertas.estado
    line="$(ultima_linea_hoy ALERTAS)"
    read -r prev_alerting prev_ts < <(lee_estado "$STATE")
    now="$NOW_EPOCH"

    cond=""
    line_epoch="$(epoch_de_linea "$line")"
    if [[ -z "$line" || -z "$line_epoch" || $((NOW_EPOCH - line_epoch)) -gt 4500 ]]; then
      cond="No hay línea [ALERTAS] de la ventana (últimos 75 min) en scheduler-out.log — el ciclo de las :30 no firingó o el scheduler está muerto. Los usuarios dejan de recibir alertas sin aviso."
    elif grep -q "Error:" <<<"$line"; then
      cond="El ciclo de alertas FALLÓ por completo: ${line}"
    else
      errores="$(grep -oE "[0-9]+ errores" <<<"$line" | grep -oE "[0-9]+" | head -1)"
      errores="${errores:-0}"
      if [[ "$errores" -gt 0 ]]; then
        if [[ "$prev_alerting" == "1" || "$FORCE" == "1" ]]; then
          cond="Errores de envío SOSTENIDOS 2 ciclos seguidos: ${line} — hay usuarios cuyas alertas no salen (hoy el caso conocido es un email con carácter no-ASCII en la dirección)."
        else
          # primer ciclo con errores: contador sostenido, sin alerta aún
          [[ "$FORCE" != "1" ]] && echo "1 $now" > "$STATE"
          echo "$(date -u +%FT%TZ) alertas: ${errores} errores (ciclo 1 sostenido) — silencio, se alerta si el siguiente ciclo repite"
          exit 0
        fi
      fi
    fi

    if [[ -n "$cond" ]]; then
      if [[ "$FORCE" != "1" && "$prev_alerting" == "1" && $((now - prev_ts)) -lt $REPEAT_S_ALERTAS ]]; then exit 0; fi
      [[ "$FORCE" != "1" ]] && echo "1 $now" > "$STATE"
      echo "$(date -u +%FT%TZ) ALERTA alertas: disparando turno agente (dedup 24h)"
      entrega "Alerta del vigilante de ciclos de elicita (alertas de usuario)" "$cond"
    else
      if [[ "$FORCE" != "1" ]]; then echo "0 0" > "$STATE"; fi
      if [[ "$prev_alerting" == "1" ]]; then
        echo "$(date -u +%FT%TZ) RECUPERADO: alertas OK — disparando aviso"
        entrega "Aviso del vigilante de ciclos de elicita (alertas de usuario)" "El ciclo de alertas volvió a estar limpio: ${line}"
      fi
      [[ "$FORCE" == "1" ]] && echo "$(date -u +%FT%TZ) TEST alertas: ciclo OK (${line}) — sin alerta"
      exit 0
    fi
    ;;

  borme)
    STATE=/tmp/elicita-ciclos-borme.estado
    # ventana diaria tras el fetch de 03:10 UTC (cron 03:40) — FORCE salta la guardia
    if [[ "$FORCE" != "1" ]]; then
      hour="$(date -u +%H)"
      [[ "$hour" == "03" || "$hour" == "04" ]] || exit 0
    fi
    read -r prev_alerting prev_ts < <(lee_estado "$STATE")
    now="$NOW_EPOCH"

    cond=""
    # El .release-tag NO se re-toca en días «sin cambios»; usamos la línea diaria
    # del log como heartbeat real del fetch de las 03:10.
    today_line="$(grep "\[${TODAY}T" "$BORME_LOG" 2>/dev/null | tail -1)"
    err_today="$(grep "\[${TODAY}T.*\] ERROR:" "$BORME_LOG" 2>/dev/null | tail -3 | tr '\n' ' | ')"
    if [[ -n "$err_today" ]]; then
      cond="El fetch diario de BORME (03:10 UTC) registró ERROR hoy: ${err_today} — Registro mercantil del perfil y reporte semanal se alimentarían de datos stale."
    elif [[ -z "$today_line" ]]; then
      cond="No hay línea del fetch BORME de hoy en ${BORME_LOG} — el job de las 03:10 no firingó o no escribió log."
    fi

    if [[ -n "$cond" ]]; then
      if [[ "$FORCE" != "1" && "$prev_alerting" == "1" && $((now - prev_ts)) -lt $REPEAT_S_BORME ]]; then exit 0; fi
      [[ "$FORCE" != "1" ]] && echo "1 $now" > "$STATE"
      echo "$(date -u +%FT%TZ) ALERTA borme: disparando turno agente (dedup 24h)"
      entrega "Alerta del vigilante de ciclos de elicita (BORME diario)" "$cond"
    else
      if [[ "$FORCE" != "1" ]]; then echo "0 0" > "$STATE"; fi
      if [[ "$prev_alerting" == "1" ]]; then
        echo "$(date -u +%FT%TZ) RECUPERADO: BORME OK — disparando aviso"
        entrega "Aviso del vigilante de ciclos de elicita (BORME diario)" "El ciclo BORME volvió a estar sano: sin ERROR hoy y línea del fetch presente."
      fi
      [[ "$FORCE" == "1" ]] && echo "$(date -u +%FT%TZ) TEST borme: ciclo OK (sin ERROR hoy, línea del fetch presente) — sin alerta"
      exit 0
    fi
    ;;

  *)
    echo "uso: $0 {reporte|alertas|borme}" >&2
    exit 1
    ;;
esac
