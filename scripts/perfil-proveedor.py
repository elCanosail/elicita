#!/usr/bin/env python3
"""
Perfil de Proveedor — Dado un NIF, genera ficha completa de su actividad
en licitaciones públicas españolas.

Queries DuckDB directamente (sin API, sin rate limits).
Output: JSON con resumen, top organismos, CPV, distribución temporal, BORME, tendencias.

Uso:
    python3 perfil-proveedor.py <NIF>
    python3 perfil-proveedor.py <NIF> --format json
    python3 perfil-proveedor.py <NIF> --format text
    python3 perfil-proveedor.py --batch nifs.txt --workers 4

Batch mode:
    nifs.txt = un NIF por línea
    --workers = sub-agentes paralelos (default 4)
"""

import argparse
import json
import re
import sys
import os
from datetime import date
from collections import Counter, defaultdict

try:
    import duckdb
except ImportError:
    print("ERROR: duckdb no instalado. pip install duckdb", file=sys.stderr)
    sys.exit(1)

DB_PATH = os.environ.get('DUCKDB_PATH', '/var/data/licitaciones/db/licitaciones.duckdb')


def get_connection():
    """Conexión read-only al DuckDB. Usa access_mode READ_ONLY para coexistir con el server."""
    return duckdb.connect(DB_PATH, read_only=True, config={'access_mode': 'READ_ONLY'})


def normalize_name(name: str) -> str:
    """Normaliza nombre de empresa para match con BORME."""
    if not name:
        return ''
    return re.sub(r'\s+', ' ', name.upper().replace(',', '').replace('.', '')).strip()


def to_date_str(v) -> str | None:
    """Convierte valor de fecha a string YYYY-MM-DD."""
    if v is None or v == '':
        return None
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    return s[:10] if len(s) >= 10 else s


def compute_trend(yearly: dict) -> str:
    """Calcula tendencia: creciente, estable, decreciente."""
    years = sorted(yearly.keys())
    if len(years) < 2:
        return 'estable'
    # Comparar últimos 3 años vs anteriores
    recent = years[-3:]
    older = years[:-3] if len(years) > 3 else years[:-1]
    if not older:
        return 'estable'
    avg_recent = sum(yearly[y] for y in recent) / len(recent)
    avg_older = sum(yearly[y] for y in older) / len(older)
    if avg_recent == 0:
        return 'decreciente'
    ratio = avg_recent / avg_older
    if ratio > 1.15:
        return 'creciente'
    elif ratio < 0.85:
        return 'decreciente'
    return 'estable'


def compute_hhi(volumes: list) -> float:
    """Índice Herfindahl-Hirschman para concentración. 0 = disperso, 1 = monopolio."""
    total = sum(volumes)
    if total == 0:
        return 0.0
    return sum((v / total) ** 2 for v in volumes)


def generate_profile(nif: str, db=None) -> dict:
    """Genera el perfil completo de un proveedor por NIF."""
    own_conn = db is None
    if own_conn:
        db = get_connection()

    try:
        nif = nif.strip().upper()
        if not nif:
            return {"ok": False, "error": "NIF requerido"}

        # 1a. Stats agregadas por año (sin LIMIT — toda la historia)
        yearly_stats = db.execute("""
            SELECT
                EXTRACT(YEAR FROM fecha_publicacion)::INT as year,
                COUNT(*) as count,
                SUM(COALESCE(importe_adjudicacion, importe_sin_iva, 0)) as volumen
            FROM calidad
            WHERE nif_adjudicatario = ? AND fecha_publicacion IS NOT NULL
            GROUP BY 1 ORDER BY 1
        """, [nif]).fetchall()

        # 1b. Top organismos (sin LIMIT)
        org_stats = db.execute("""
            SELECT
                organo_contratante AS organismo,
                COUNT(*) as contratos,
                SUM(COALESCE(importe_adjudicacion, importe_sin_iva, 0)) as volumen
            FROM calidad
            WHERE nif_adjudicatario = ? AND fecha_publicacion IS NOT NULL
            GROUP BY 1 ORDER BY contratos DESC
            LIMIT 20
        """, [nif]).fetchall()

        # 1c. Top CPV (sin LIMIT)
        cpv_stats = db.execute("""
            SELECT
                CASE
                    WHEN cpv_principal IS NOT NULL
                        THEN TRIM(REPLACE(REPLACE(CAST(cpv_principal AS VARCHAR), '.0', ''), ' ', ''))
                    ELSE COALESCE(SPLIT_PART(cpvs, ',', 1), '')
                END AS cpv,
                COUNT(*) as contratos
            FROM calidad
            WHERE nif_adjudicatario = ? AND fecha_publicacion IS NOT NULL
            GROUP BY 1 ORDER BY contratos DESC
            LIMIT 20
        """, [nif]).fetchall()

        # 1d. Contratos recientes (con LIMIT — solo muestra)
        contratos = db.execute("""
            SELECT
                objeto AS titulo,
                organo_contratante AS organismo,
                COALESCE(importe_adjudicacion, importe_sin_iva, 0) AS importe,
                fecha_publicacion AS fecha,
                archivo_origen AS fuente,
                CASE
                    WHEN cpv_principal IS NOT NULL
                        THEN TRIM(REPLACE(REPLACE(CAST(cpv_principal AS VARCHAR), '.0', ''), ' ', ''))
                    ELSE COALESCE(SPLIT_PART(cpvs, ',', 1), '')
                END AS cpv,
                estado,
                url AS url_pub,
                adjudicatario
            FROM calidad
            WHERE nif_adjudicatario = ?
              AND fecha_publicacion IS NOT NULL
            ORDER BY fecha_publicacion DESC NULLS LAST
            LIMIT 500
        """, [nif]).fetchall()

        if not contratos and not yearly_stats:
            return {"ok": False, "error": f"NIF {nif} no encontrado en calidad"}

        # Procesar stats agregadas (datos completos, no muestra)
        total_contratos = sum(r[1] for r in yearly_stats) if yearly_stats else 0
        volumen_total = sum(float(r[2] or 0) for r in yearly_stats) if yearly_stats else 0
        contrato_medio = volumen_total / total_contratos if total_contratos > 0 else 0

        # Distribución temporal desde yearly_stats (completa)
        distribucion_temporal = {str(r[0]): r[1] for r in yearly_stats if r[0] and r[0] > 1970}

        # Fechas desde yearly_stats
        years_validos = [r[0] for r in yearly_stats if r[0] and r[0] > 1970]
        primer_contrato = f"{min(years_validos)}-01-01" if years_validos else None
        ultimo_contrato = f"{max(years_validos)}-12-31" if years_validos else None
        anos_activo = (max(years_validos) - min(years_validos) + 1) if years_validos else 0

        # Nombre canonical (más frecuente de la muestra reciente)
        nombres = Counter(str(r[8] or '').strip() for r in contratos if r[8])
        nombre = nombres.most_common(1)[0][0] if nombres else nif

        # Top organismos desde org_stats (datos completos)
        top_organismos = [
            {
                "organismo": str(r[0] or 'No especificado').strip(),
                "contratos": int(r[1]),
                "volumen_eur": round(float(r[2] or 0), 2)
            }
            for r in org_stats[:10]
        ]

        # Top CPV desde cpv_stats (datos completos)
        top_cpv = [
            {"cpv": str(r[0] or '').strip(), "contratos": int(r[1])}
            for r in cpv_stats[:10] if r[0]
        ]

        # Concentración desde org_stats
        org_volumes = [float(r[2] or 0) for r in org_stats]
        hhi = round(compute_hhi(org_volumes), 4)
        top3_vol = sum(sorted(org_volumes, reverse=True)[:3])
        top3_pct = round(top3_vol / volumen_total, 4) if volumen_total > 0 else 0

        # Tendencia
        tendencia = compute_trend(distribucion_temporal)

        # BORME enrichment
        borme = {}
        try:
            # Normalizar nombre para match
            norm = nombre.upper().replace(',', '').replace('.', '').strip()
            borme_rows = db.execute("""
                SELECT empresa, domicilio, capital_euros, fecha_constitucion,
                       provincia, fecha_borme
                FROM borme_empresas
                WHERE empresa LIKE ?
                ORDER BY fecha_borme DESC
                LIMIT 50
            """, [f"%{norm}%"]).fetchall()

            for r in borme_rows:
                if not borme.get("domicilio") and r[1]:
                    borme["domicilio"] = str(r[1]).strip()
                if "capital_euros" not in borme and r[2] is not None:
                    try:
                        borme["capital_euros"] = float(r[2])
                    except (ValueError, TypeError):
                        pass
                if not borme.get("fecha_constitucion") and r[3]:
                    borme["fecha_constitucion"] = to_date_str(r[3])
                if not borme.get("provincia") and r[4]:
                    borme["provincia"] = str(r[4]).strip()
                if not borme.get("fecha_borme") and r[5]:
                    borme["fecha_borme"] = to_date_str(r[5])
        except Exception as e:
            borme["_error"] = str(e)

        # Contratos recientes (últimos 5)
        contratos_recientes = []
        for r in contratos[:5]:
            contratos_recientes.append({
                "titulo": str(r[0] or 'Sin título')[:200],
                "organismo": str(r[1] or 'No especificado')[:150],
                "importe_eur": round(float(r[2] or 0), 2),
                "fecha": to_date_str(r[3]),
                "fuente": str(r[4] or ''),
                "estado": str(r[6] or ''),
            })

        return {
            "ok": True,
            "nif": nif,
            "nombre": nombre,
            "resumen": {
                "total_contratos": total_contratos,
                "volumen_total_eur": round(volumen_total, 2),
                "contrato_medio_eur": round(contrato_medio, 2),
                "primer_contrato": primer_contrato,
                "ultimo_contrato": ultimo_contrato,
                "anos_activo": anos_activo,
            },
            "top_organismos": top_organismos,
            "top_cpv": top_cpv,
            "distribucion_temporal": distribucion_temporal,
            "concentracion": {
                "hhi": hhi,
                "top_3_pct_volumen": top3_pct,
            },
            "tendencia": tendencia,
            "contratos_recientes": contratos_recientes,
            "borme": borme if borme else None,
        }

    finally:
        if own_conn:
            db.close()


def format_text(profile: dict) -> str:
    """Formato texto legible para Telegram/consola."""
    if not profile.get("ok"):
        return f"❌ {profile.get('error', 'Error desconocido')}"

    r = profile["resumen"]
    lines = [
        f"📋 PERFIL DE PROVEEDOR",
        f"━━━━━━━━━━━━━━━━━━━━━━",
        f"NIF: {profile['nif']}",
        f"Nombre: {profile['nombre']}",
        f"",
        f"📊 Resumen:",
        f"  Contratos: {r['total_contratos']}",
        f"  Volumen total: {r['volumen_total_eur']:,.0f} €",
        f"  Contrato medio: {r['contrato_medio_eur']:,.0f} €",
        f"  Activo desde: {r['primer_contrato']} ({r['anos_activo']} años)",
        f"  Último contrato: {r['ultimo_contrato']}",
        f"",
        f"📈 Tendencia: {profile['tendencia']}",
        f"🔒 Concentración: HHI={profile['concentracion']['hhi']:.2f} | Top-3 = {profile['concentracion']['top_3_pct_volumen']:.0%}",
        f"",
        f"🏛 Top organismos:",
    ]

    for i, org in enumerate(profile["top_organismos"][:5], 1):
        lines.append(f"  {i}. {org['organismo'][:50]} — {org['contratos']} contratos, {org['volumen_eur']:,.0f} €")

    if profile["top_cpv"]:
        lines.append(f"\n🏷 Top CPV:")
        for i, cpv in enumerate(profile["top_cpv"][:5], 1):
            lines.append(f"  {i}. {cpv['cpv']} — {cpv['contratos']} contratos")

    if profile["distribucion_temporal"]:
        lines.append(f"\n📅 Distribución temporal:")
        for year, count in profile["distribucion_temporal"].items():
            bar = "█" * min(count, 20)
            lines.append(f"  {year}: {bar} {count}")

    if profile["borme"]:
        lines.append(f"\n🏢 BORME:")
        b = profile["borme"]
        if b.get("domicilio"):
            lines.append(f"  Domicilio: {b['domicilio']}")
        if "capital_euros" in b:
            lines.append(f"  Capital: {b['capital_euros']:,.0f} €")
        if b.get("fecha_constitucion"):
            lines.append(f"  Constitución: {b['fecha_constitucion']}")
        if b.get("provincia"):
            lines.append(f"  Provincia: {b['provincia']}")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Perfil de proveedor por NIF")
    parser.add_argument("nif", nargs="?", help="NIF del proveedor")
    parser.add_argument("--format", choices=["json", "text"], default="text", help="Formato de salida")
    parser.add_argument("--batch", help="Archivo con NIFs (uno por línea) para procesamiento batch")
    parser.add_argument("--workers", type=int, default=4, help="Workers paralelos en batch mode")
    parser.add_argument("--output", "-o", help="Archivo de salida en batch mode")

    args = parser.parse_args()

    if args.batch:
        # Batch mode
        with open(args.batch) as f:
            nifs = [line.strip().upper() for line in f if line.strip() and not line.startswith('#')]

        print(f"Procesando {len(nifs)} NIFs con {args.workers} workers...", file=sys.stderr)

        db = get_connection()
        results = []
        for i, nif in enumerate(nifs, 1):
            profile = generate_profile(nif, db=db)
            results.append(profile)
            status = "✅" if profile.get("ok") else "❌"
            print(f"  [{i}/{len(nifs)}] {status} {nif} — {profile.get('nombre', profile.get('error', ''))[:50]}", file=sys.stderr)

        db.close()

        output = json.dumps(results, ensure_ascii=False, indent=2)
        if args.output:
            with open(args.output, 'w') as f:
                f.write(output)
            print(f"\nResultados guardados en {args.output}", file=sys.stderr)
        else:
            print(output)
        return

    if not args.nif:
        parser.error("NIF requerido (o usar --batch)")

    profile = generate_profile(args.nif)

    if args.format == "json":
        print(json.dumps(profile, ensure_ascii=False, indent=2))
    else:
        print(format_text(profile))


if __name__ == "__main__":
    main()