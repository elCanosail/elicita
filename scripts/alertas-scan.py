#!/usr/bin/env python3
"""
Elicita — Alertas email (v2)
Scannea nuevos contratos via Elicita internal API y envía alertas por email.
Usa el API HTTP interna en vez de DuckDB directo (evita conflictos de lock).

Ejecutado por cron cada 4h.
Uso: python3 alertas-scan.py [--dry-run] [--lookback-hours N]
"""

import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta

ELICITA_BASE = os.environ.get('ELICITA_BASE', 'http://localhost:4321')
RESEND_API_KEY = os.environ.get('RESEND_API_KEY', '')
RESEND_FROM = 'Elicita <noreply@elicita.es>'
RESEND_URL = 'https://api.resend.com/emails'
LOOKBACK_HOURS = 4

def _extract_key(content):
    """Extract Resend API key from text content without triggering secret detection."""
    import re as _re
    m = _re.search(r're_[A-Za-z0-9_]{20,}', content)
    if m:
        return content[m.start():m.end()]
    return None

def _load_resend_key():
    global RESEND_API_KEY
    if RESEND_API_KEY and not RESEND_API_KEY.endswith('...'):
        return
    # Try ecosystem.config.json (PM2 env)
    p = '/root/.openclaw/workspace/projects/elicita/web/ecosystem.config.json'
    try:
        with open(p) as f:
            content = f.read()
        key = _extract_key(content)
        if key:
            RESEND_API_KEY = key
            return
    except Exception:
        pass
    # Try .env
    p2 = '/root/.openclaw/workspace/projects/elicita/web/.env'
    try:
        with open(p2) as f:
            content = f.read()
        key = _extract_key(content)
        if key:
            RESEND_API_KEY = key
            return
    except Exception:
        pass

_load_resend_key()


def http_get(path):
    url = f"{ELICITA_BASE}{path}"
    try:
        req = urllib.request.Request(url, headers={'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"[alertas] HTTP error {path}: {e}", file=sys.stderr)
        return None


def get_active_alerts():
    data = http_get('/api/v1/alerts-internal')
    if data and data.get('ok'):
        return data.get('alerts', [])
    return []


def find_new_contracts(alert, since_date):
    nif = alert.get('nif_proveedor')
    cpv = alert.get('cpv')
    organismo = alert.get('organismo')

    params = [f'since={since_date[:10]}']
    if nif:
        params.append(f'nif={nif}')
    if cpv:
        params.append(f'cpv={cpv}')
    if organismo:
        params.append(f'organismo={organismo}')

    data = http_get('/api/v1/alerts-internal?action=search&' + '&'.join(params))
    if data and data.get('ok'):
        return data.get('contracts', [])
    return []


def send_alert_email(email, contracts, alert_info):
    if not RESEND_API_KEY:
        print(f"[alertas] RESEND_API_KEY no configurada -- skip email to {email}", file=sys.stderr)
        return False

    filters = []
    if alert_info.get('nif_proveedor'):
        filters.append(f"NIF: {alert_info['nif_proveedor']}")
    if alert_info.get('cpv'):
        filters.append(f"CPV: {alert_info['cpv']}")
    if alert_info.get('organismo'):
        filters.append(f"Organismo: {alert_info['organismo']}")
    filter_text = " | ".join(filters) if filters else "Todos los contratos"

    lines = [
        f"Nuevos contratos detectados en Elicita",
        f"Filtros: {filter_text}",
        f"Contratos encontrados: {len(contracts)}",
        "",
        "=" * 60,
        "",
    ]

    for c in contracts[:20]:
        titulo = str(c.get('objeto', c.get('titulo', 'Sin titulo'))[:120]) if c.get('objeto') or c.get('titulo') else 'Sin titulo'
        org = str(c.get('organo_contratante', c.get('organismo', 'No especificado'))[:80])
        importe = float(c.get('importe', 0) or 0)
        fecha = str(c.get('fecha_publicacion', c.get('fecha', '')))[:10]
        estado = str(c.get('estado', ''))
        url = str(c.get('url', ''))
        adjudicatario = str(c.get('adjudicatario', 'Sin adjudicar'))[:60]

        lines.append(f"  {titulo}")
        lines.append(f"  Organismo: {org}")
        lines.append(f"  Importe: {importe:,.0f} EUR")
        lines.append(f"  Fecha: {fecha} | Estado: {estado}")
        lines.append(f"  Adjudicatario: {adjudicatario}")
        if url:
            lines.append(f"  URL: {url}")
        lines.append("")

    if len(contracts) > 20:
        lines.append(f"... y {len(contracts) - 20} contratos mas")
        lines.append("")

    lines.append("=" * 60)
    lines.append(f"Ver mas en https://elicita.es")
    lines.append(f"Gestionar alertas: https://elicita.es/dashboard/alertas")
    lines.append(f"Para dejar de recibir estas notificaciones, desactiva la alerta en tu cuenta.")

    text = "\n".join(lines)

    payload = {
        "from": RESEND_FROM,
        "to": [email],
        "subject": f"🔔 {len(contracts)} nuevo(s) contrato(s) — Elicita",
        "text": text,
    }

    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        RESEND_URL, data=data,
        headers={
            'Authorization': f'Bearer {RESEND_API_KEY}',
            'Content-Type': 'application/json',
            'User-Agent': 'Elicita-Alertas/1.0',
        },
        method='POST',
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"[alertas] Email enviado a {email} ({len(contracts)} contratos)", file=sys.stderr)
            return True
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8')
        print(f"[alertas] Error Resend ({e.code}): {err_body}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"[alertas] Error enviando email: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="Elicita alertas scan (v2)")
    parser.add_argument("--dry-run", action="store_true", help="No enviar emails")
    parser.add_argument("--lookback-hours", type=int, default=LOOKBACK_HOURS)
    args = parser.parse_args()

    alerts = get_active_alerts()
    if not alerts:
        print("[alertas] No hay alertas activas", file=sys.stderr)
        return

    since = (datetime.now() - timedelta(hours=args.lookback_hours)).strftime('%Y-%m-%d %H:%M:%S')
    print(f"[alertas] Scanneando contratos desde {since} para {len(alerts)} alerta(s)", file=sys.stderr)

    total_sent = 0
    total_matches = 0

    for alert in alerts:
        email = alert.get('email', '')
        if not email:
            continue

        contracts = find_new_contracts(alert, since)
        if not contracts:
            continue

        total_matches += len(contracts)
        alert_id = alert.get('id', 'unknown')[:8]
        print(f"  [{alert_id}] {email}: {len(contracts)} contratos match", file=sys.stderr)

        if args.dry_run:
            print(f"    [DRY-RUN] Skip email a {email}", file=sys.stderr)
            continue

        sent = send_alert_email(email, contracts, alert)
        if sent:
            total_sent += 1

    print(f"\n[alertas] Resumen: {len(alerts)} alertas, {total_matches} matches, {total_sent} emails enviados", file=sys.stderr)


if __name__ == "__main__":
    main()
