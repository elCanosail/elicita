#!/usr/bin/env python3
"""
alert_matcher.py — Elicita email alert dispatcher
Matches new licitaciones from DuckDB against user alert configs stored in Clerk.
Sends email summaries via Resend API.

Cron (every 4 hours):
  0 */4 * * * cd /root/.openclaw/workspace/projects/elicita/ingesta/connectors && python3 alert_matcher.py >> /var/log/elicita-alertas.log 2>&1

Daily summary only (at 8:00 AM):
  0 8 * * * cd /root/.openclaw/workspace/projects/elicita/ingesta/connectors && python3 alert_matcher.py >> /var/log/elicita-alertas.log 2>&1
"""

import json
import os
import sys
import datetime
from pathlib import Path

import requests

# ── Config ─────────────────────────────────────────────────────────────────────
CLERK_SECRET = "sk_live_[REDACTED — el valor vivo está en .env.production]"
RESEND_API_KEY = "re_[REDACTED — el valor vivo está en .env.production]"
FROM_EMAIL = "Elicita <noreply@elicita.es>"

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
STATE_FILE = DATA_DIR / "alertas_state.json"
DUCKDB_PATH = Path("/var/data/licitaciones/db/licitaciones.duckdb")

# Current hour (UTC) — used to filter "diario" users
CURRENT_HOUR = datetime.datetime.utcnow().hour


# ── Logging ────────────────────────────────────────────────────────────────────
def log(msg: str):
    ts = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", file=sys.stderr)


# ── State management ───────────────────────────────────────────────────────────
def load_last_check() -> datetime.datetime:
    if STATE_FILE.exists():
        try:
            data = json.loads(STATE_FILE.read_text())
            return datetime.datetime.fromisoformat(data["last_check"].replace("Z", "+00:00"))
        except Exception as e:
            log(f"WARN: Could not read state file: {e}")
    # Default: 4 hours ago
    return datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=4)


def save_last_check():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    STATE_FILE.write_text(json.dumps({"last_check": now}, indent=2))
    log(f"State saved: last_check = {now}")


# ── Clerk: fetch active alert users ───────────────────────────────────────────
def get_alert_users() -> list[dict]:
    """Returns list of {email, alertas} for users with alertas.activo == True."""
    headers = {"Authorization": f"Bearer {CLERK_SECRET}"}
    users = []
    offset = 0
    limit = 100

    while True:
        resp = requests.get(
            "https://api.clerk.com/v1/users",
            headers=headers,
            params={"limit": limit, "offset": offset},
            timeout=15,
        )
        if not resp.ok:
            log(f"ERROR: Clerk API {resp.status_code}: {resp.text[:200]}")
            break
        batch = resp.json()
        if not batch:
            break

        for user in batch:
            meta = user.get("public_metadata") or {}
            alertas = meta.get("alertas")
            if not alertas or not alertas.get("activo"):
                continue
            emails = user.get("email_addresses") or []
            primary_id = user.get("primary_email_address_id")
            email = ""
            for e in emails:
                if e.get("id") == primary_id:
                    email = e.get("email_address", "")
                    break
            if not email and emails:
                email = emails[0].get("email_address", "")
            if not email:
                continue
            users.append({"email": email, "alertas": alertas})

        if len(batch) < limit:
            break
        offset += limit

    log(f"Clerk: {len(users)} users with active alerts")
    return users


# ── Load all contracts from JSON ingesta files ────────────────────────────────
def load_ingesta_contracts(since: datetime.datetime) -> list[dict]:
    """Load contracts from JSON ingesta files, filtering by _first_seen or fecha_publicacion >= since."""
    since_str = since.isoformat()
    all_contracts = []
    
    json_files = list(DATA_DIR.glob("*_contracts.json"))
    for fpath in json_files:
        try:
            raw = json.loads(fpath.read_text())
            contratos = []
            if isinstance(raw, dict):
                contratos = raw.get("contratos", [])
            elif isinstance(raw, list):
                contratos = raw
            
            for c in contratos:
                # Check if new since last check
                first_seen = c.get("_first_seen") or c.get("_merged_at") or c.get("fecha_publicacion") or ""
                if first_seen and first_seen >= since_str:
                    all_contracts.append(c)
        except Exception as e:
            log(f"WARN: Error reading {fpath.name}: {e}")
    
    return all_contracts


def find_matches(all_contracts: list[dict], alertas: dict) -> list[dict]:
    """Returns up to 20 matching licitaciones for a user's alert config."""
    cpvs = set(alertas.get("cpvs") or [])
    organismos = [o.lower() for o in (alertas.get("organismos") or []) if o]
    keywords = [k.lower() for k in (alertas.get("keywords") or []) if k]

    if not cpvs and not organismos and not keywords:
        return []

    matches = []
    for c in all_contracts:
        # CPV match: check if any contract CPV starts with any alert CPV
        contract_cpvs = c.get("cpvs") or []
        cpv_principal = c.get("cpv_principal") or c.get("cpv") or ""
        if cpv_principal:
            contract_cpvs = [cpv_principal] + contract_cpvs
        
        cpv_match = False
        if cpvs:
            for cc in contract_cpvs:
                cc_str = str(cc).replace(".0", "")[:8]
                if any(cc_str.startswith(uc[:8]) for uc in cpvs):
                    cpv_match = True
                    break

        # Organismo match
        org_match = False
        org_name = (c.get("organismo") or c.get("organo_contratante") or "").lower()
        if organismos and org_name:
            org_match = any(o in org_name for o in organismos)

        # Keyword match in titulo/objeto
        kw_match = False
        titulo = (c.get("titulo") or c.get("objeto") or "").lower()
        if keywords and titulo:
            kw_match = any(k in titulo for k in keywords)

        if cpv_match or org_match or kw_match:
            matches.append({
                "id": c.get("id", ""),
                "objeto": c.get("titulo") or c.get("objeto") or "",
                "organo_contratante": c.get("organismo") or c.get("organo_contratante") or "",
                "cpv_principal": str(cpv_principal).replace(".0", ""),
                "importe_adjudicacion": c.get("importe_licitacion") or c.get("importe_adjudicacion"),
                "fecha_publicacion": c.get("fecha_publicacion") or c.get("_first_seen") or "",
                "estado": c.get("estado") or "",
                "url": c.get("url_fuente") or c.get("url") or "",
            })
        
        if len(matches) >= 21:
            break

    # Sort by fecha desc
    matches.sort(key=lambda x: x.get("fecha_publicacion", ""), reverse=True)
    return matches[:21]


# ── Email builder ──────────────────────────────────────────────────────────────
def build_email_html(matches: list[dict]) -> str:
    shown = matches[:20]
    extra = len(matches) - 20 if len(matches) > 20 else 0

    rows_html = ""
    for m in shown:
        objeto = (m.get("objeto") or "Sin descripción")[:100]
        if len(m.get("objeto") or "") > 100:
            objeto += "…"
        organismo = m.get("organo_contratante") or "—"
        cpv = str(m.get("cpv_principal") or "—")
        importe_raw = m.get("importe_adjudicacion")
        if importe_raw and str(importe_raw) not in ("None", "0", ""):
            try:
                importe = f"€{float(importe_raw):,.0f}".replace(",", ".")
            except Exception:
                importe = str(importe_raw)
        else:
            importe = "—"
        fecha = str(m.get("fecha_publicacion") or "")[:10]
        url = m.get("url") or "https://elicita.es/buscador"

        rows_html += f"""
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
            <a href="{url}" style="color:#10b981;text-decoration:none;font-size:13px;font-weight:500;display:block;margin-bottom:5px">{objeto}</a>
            <div style="font-size:11px;color:rgba(255,255,255,0.4);font-family:'Courier New',monospace">
              {organismo} &nbsp;·&nbsp; CPV: {cpv} &nbsp;·&nbsp; {importe} &nbsp;·&nbsp; {fecha}
            </div>
          </td>
        </tr>"""

    extra_html = ""
    if extra > 0:
        extra_html = f"""
        <tr>
          <td style="padding:12px 0;color:rgba(255,255,255,0.4);font-size:12px;font-style:italic">
            + {extra} licitaciones más. <a href="https://elicita.es/buscador" style="color:#10b981">Ver todas en elicita.es</a>
          </td>
        </tr>"""

    return f"""<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#080808;font-family:'Helvetica Neue',Arial,sans-serif;color:rgba(255,255,255,0.85)">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#080808;min-height:100vh">
    <tr><td align="center" style="padding:40px 20px">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

        <!-- Header -->
        <tr><td style="padding-bottom:32px;border-bottom:1px solid rgba(255,255,255,0.07)">
          <a href="https://elicita.es" style="text-decoration:none;font-family:'Courier New',monospace;font-size:18px;color:rgba(255,255,255,0.9)">
            elicita<span style="color:#10b981">_</span>
          </a>
        </td></tr>

        <!-- Title -->
        <tr><td style="padding:28px 0 20px">
          <h1 style="margin:0;font-size:20px;font-weight:500;color:rgba(255,255,255,0.9)">
            🔔 {len(shown)} nueva{'s' if len(shown) != 1 else ''} licitaci{'ones' if len(shown) != 1 else 'ón'} en tus sectores
          </h1>
          <p style="margin:8px 0 0;font-size:13px;color:rgba(255,255,255,0.4)">
            Estas licitaciones coinciden con tus criterios de alerta
          </p>
        </td></tr>

        <!-- Licitaciones -->
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0">
            {rows_html}
            {extra_html}
          </table>
        </td></tr>

        <!-- CTA -->
        <tr><td style="padding:28px 0">
          <a href="https://elicita.es/buscador"
             style="display:inline-block;background:#10b981;color:#080808;text-decoration:none;font-size:13px;font-weight:600;padding:11px 24px;border-radius:6px">
            Ver en elicita_ →
          </a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding-top:24px;border-top:1px solid rgba(255,255,255,0.07)">
          <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.2);font-family:'Courier New',monospace">
            Gestiona tus alertas en
            <a href="https://elicita.es/cuenta/alertas" style="color:rgba(16,185,129,0.7)">elicita.es/cuenta/alertas</a>
            &nbsp;·&nbsp; No responder a este email
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>"""


# ── Email sender ───────────────────────────────────────────────────────────────
def send_alert(to_email: str, subject: str, html: str) -> bool:
    resp = requests.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
        json={"from": FROM_EMAIL, "to": to_email, "subject": subject, "html": html},
        timeout=15,
    )
    if resp.ok:
        log(f"Email sent to {to_email}")
        return True
    else:
        log(f"ERROR: Resend {resp.status_code} for {to_email}: {resp.text[:200]}")
        return False


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    log("=== alert_matcher started ===")

    # Load state
    last_check = load_last_check()
    log(f"Checking for new licitaciones since {last_check.isoformat()}")

    # Get users with active alerts
    users = get_alert_users()
    if not users:
        log("No users with active alerts. Exiting.")
        save_last_check()
        return

    # Load all new contracts from JSON ingesta files
    all_contracts = load_ingesta_contracts(last_check)
    log(f"Loaded {len(all_contracts)} new contracts from ingesta JSON files")

    sent_count = 0
    skipped_diario = 0

    for user in users:
        email = user["email"]
        alertas = user["alertas"]
        frecuencia = alertas.get("frecuencia", "4h")

        # "diario" users only get email at 8:00 AM UTC run
        if frecuencia == "diario" and CURRENT_HOUR != 8:
            skipped_diario += 1
            continue

        matches = find_matches(all_contracts, alertas)
        if not matches:
            log(f"No matches for {email}")
            continue

        n = min(len(matches), 20)
        subject = f"🔔 {n} nueva{'s' if n != 1 else ''} licitaci{'ones' if n != 1 else 'ón'} en tus sectores — elicita_"
        html = build_email_html(matches)
        if send_alert(email, subject, html):
            sent_count += 1

    log(f"Done. Emails sent: {sent_count} | Skipped (diario, wrong hour): {skipped_diario}")
    save_last_check()


if __name__ == "__main__":
    main()
