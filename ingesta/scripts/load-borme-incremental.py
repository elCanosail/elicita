#!/usr/bin/env python3
"""
load-borme-incremental.py — Refresco incremental de las tablas BORME en DuckDB.

Fase 0 del plan BORME (2026-10-14). Cierre del hueco 2026-02-19 → hoy:

1. Snapshot upstream (BquantFinance/licitaciones-espana): si en BORME_DIR hay
   parquets con cobertura mayor que la BD, recarga borme_empresas y
   borme_cargos con DROP+CREATE (semántica del loader original
   scripts/load-borme-calidad.py, commit 806607e). El parquet v2026.10
   (descargado por borme-fetch-release.sh) cubre 2009-01-02 → 2026-10-01.

2. BORME diario (boe.es, datos abiertos): para los días posteriores al máximo
   fecha_borme de la BD (tope BORME_MAX_XML_DAYS por ejecución), descarga el
   sumario diario (API datos abiertos) + el XML de cada entrada BORME-A, y
   hace INSERT de filas nuevas — nunca toca filas existentes. Los XML se
   cachean en disco: tras un recarga de parquet, los días ya cacheados se
   reinsertan sin re-descargar.

Nombres de persona: los actos del XML traen el nombre real. Se guarda en
borme_personas (persona_hash → nombre) con el MISMO esquema que el dataset
upstream: sha256('borme_2024:' + NOMBRE.strip().upper())[:16] — verificado
byte a byte contra el parquet histórico (INDRA 2009-02-02: hashes idénticos).
Así las filas nuevas son reversibles (tabla de nombres) y consistentes con
los 17.7M de cargos históricos (los históricos siguen siendo opacos).

Uso:
  DUCKDB_PATH=/tmp/test.duckdb python3 load-borme-incremental.py
  DUCKDB_PATH=/tmp/test.duckdb python3 load-borme-incremental.py --xml-only
  DUCKDB_PATH=/tmp/test.duckdb python3 load-borme-incremental.py --parquet-only

Seguridad: NO escribe nunca en la BD live — dentro del materializador
(ingesta/scripts/materialize-duckdb.sh) DUCKDB_PATH apunta al CANDIDATE y la
única puerta a licitaciones.duckdb es su promoción atómica por rename.
"""

import os
import re
import sys
import time
import hashlib
import zipfile
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from datetime import date, datetime, timedelta

import duckdb

DB_PATH = os.environ.get('DUCKDB_PATH', '/var/data/licitaciones/db/licitaciones.duckdb')
BORME_DIR = Path(os.environ.get('BORME_DIR', '/var/data/licitaciones/data/borme'))
BORME_XML_DIR = Path(os.environ.get('BORME_XML_DIR', '/var/data/licitaciones/data/borme-xml'))
BORME_MAX_XML_DAYS = int(os.environ.get('BORME_MAX_XML_DAYS', '7'))
HTTP_TIMEOUT = 60
HTTP_RETRIES = 3
SLEEP_BETWEEN_REQUESTS = float(os.environ.get('BORME_HTTP_SLEEP', '0.3'))

SUMARIO_URL = 'https://www.boe.es/datosabiertos/api/borme/sumario/{yyyymmdd}'
ENTRADA_URL = 'https://www.boe.es/diario_borme/xml.php?id={id}'
# UA identificable; BOE lo pide para datos abiertos
HTTP_HEADERS = {
    'User-Agent': 'elicita-ingesta/1.0 (+https://elicita.es; datos abiertos BOE)',
    'Accept': 'application/xml',
}

# ── Esquema upstream replicado ────────────────────────────────────────────

PERSONA_SALT = 'borme_2024'


def hash_persona(name: str) -> str:
    """Código seudónimo upstream (borme_anonymize.py, verificado)."""
    if not name or not isinstance(name, str):
        return ''
    raw = f"{PERSONA_SALT}:{name.strip().upper()}"
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()[:16]


SUFFIXES = {
    'SL', 'SLU', 'SLE', 'SLP', 'SLL', 'SA', 'SAU', 'SAP', 'SC', 'SCA', 'SCL',
    'CB', 'AIE', 'UTE', 'SGR', 'EIRELL',
    'SOCIEDADLIMITADA', 'SOCIEDADANONIMA', 'SOCIEDADLABORAL', 'SOCIEDADCIVIL',
    'SOCIEDADCOMANDITARIA', 'COMANDITARIAPORACCIONES', 'COMANDITARIA',
}


def normalize_empresa(name: str) -> str:
    """
    Réplica de la regla upstream de `empresa_norm` (calibrada contra pares
    reales del parquet): mayúsculas, colapsar espacios, recorte de sufijos
    societarios finales — salvo cuando el nombre trae anotación posterior
    ('SL. SOCIEDAD UNIPERSONAL'), caso en el que upstream no recorta nada.
    Conserva acentos, comas y puntos (igual que upstream).
    """
    up = ' '.join((name or '').upper().split())
    if not up:
        return up
    if 'UNIPERSONAL' in up:
        return up
    tokens = up.split(' ')

    def _core(tok: str) -> str:
        return re.sub(r'[^A-Z0-9ÁÉÍÓÚÜÑ]', '', tok)

    out = list(tokens)
    while len(out) > 1 and _core(out[-1]) in SUFFIXES:
        out.pop()
    return ' '.join(out)


def fmt_fecha_corta(d: date, with_dot: bool) -> str:
    """Estilo upstream: '2.12.25.' (constitución, con punto final) /
    '27.10.99' (inscripción, sin punto) — día sin cero, mes a 2 dígitos."""
    s = f"{d.day}.{d.month:02d}.{d.year % 100:02d}"
    return s + '.' if with_dot else s


# ── HTTP con reintentos ───────────────────────────────────────────────────

def http_get(url: str, accept: str = 'application/xml') -> bytes | None:
    import urllib.request
    import urllib.error
    headers = dict(HTTP_HEADERS)
    headers['Accept'] = accept
    last_err = None
    for attempt in range(HTTP_RETRIES):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return resp.read()
        except Exception as e:  # noqa: BLE001 — reintento controlado
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    print(f"  ⚠️  GET {url} falló tras {HTTP_RETRIES} intentos: {last_err}")
    return None


# ── Paso 1: parquet snapshot (semántica del loader original) ─────────────

def db_max_fecha(con) -> date | None:
    row = con.execute("SELECT MAX(fecha_borme) FROM borme_empresas").fetchone()
    if not row or row[0] is None:
        return None
    v = row[0]
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return datetime.fromisoformat(str(v)[:10]).date()


def parquet_max_fecha(borme_dir: Path) -> date | None:
    emp = borme_dir / 'borme_empresas_pub.parquet'
    if not emp.exists():
        return None
    con = duckdb.connect()  # conexión efímera, solo lectura del parquet
    try:
        row = con.execute(
            f"SELECT MAX(fecha_borme) FROM read_parquet('{emp.as_posix()}')"
        ).fetchone()
        return row[0].date() if row and row[0] else None
    finally:
        con.close()


def refresh_from_parquet(con) -> bool:
    """DROP+CREATE borme_* desde los parquets locales si son más nuevos que la
    BD. Semántica del loader original (806607e), pero solo las tablas BORME:
    calidad, nif_canonical y la vista nacional no se tocan."""
    emp_pq = BORME_DIR / 'borme_empresas_pub.parquet'
    car_pq = BORME_DIR / 'borme_cargos_pub.parquet'
    if not emp_pq.exists() or not car_pq.exists():
        print(f"[parquet] sin parquets en {BORME_DIR} — paso omitido (el fetch del release los deja ahí)")
        return False
    pq_max = parquet_max_fecha(BORME_DIR)
    db_max = db_max_fecha(con)
    print(f"[parquet] cobertura parquet hasta {pq_max} · BD hasta {db_max}")
    if pq_max is None or (db_max is not None and pq_max <= db_max):
        print("[parquet] parquet no más nuevo que la BD — sin recarga")
        return False
    t0 = time.time()
    print("[parquet] recargando borme_empresas…")
    con.execute("DROP TABLE IF EXISTS borme_empresas")
    con.execute(f"CREATE TABLE borme_empresas AS SELECT * FROM read_parquet('{emp_pq.as_posix()}')")
    print(f"  ✅ borme_empresas: {con.execute('SELECT COUNT(*) FROM borme_empresas').fetchone()[0]:,} filas")
    print("[parquet] recargando borme_cargos…")
    con.execute("DROP TABLE IF EXISTS borme_cargos")
    con.execute(f"CREATE TABLE borme_cargos AS SELECT * FROM read_parquet('{car_pq.as_posix()}')")
    print(f"  ✅ borme_cargos: {con.execute('SELECT COUNT(*) FROM borme_cargos').fetchone()[0]:,} filas")
    # borme_personas NO se toca: el hash es determinista y los nombres siguen
    # siendo válidos tras una recarga de parquet.
    print(f"[parquet] recarga completa ({time.time() - t0:.1f}s)")
    return True


# ── Paso 2: XML diario de boe.es ─────────────────────────────────────────

# Cabeceras de acto que abre parrafo, en el orden en que el BORME las escribe.
ACTO_HEADERS = [
    'Ceses/Dimisiones', 'Revocaciones', 'Nombramientos', 'Reelecciones',
    'Otros conceptos', 'Modificaciones estatutarias', 'Ampliación de capital',
    'Reducción de capital', 'Cambio de domicilio social', 'Cambio del objeto social',
    'Cambio de objeto social', 'Constitución', 'Declaración de unipersonalidad',
    'Declaración de sociedad unipersonal', 'Disolución', 'Extinción',
    'Apertura de sucursal', 'Apertura de agencia', 'Fusión', 'Escisión',
    'Transformación', 'Reactivación', 'Fe de erratas', 'Situación concursal',
    'Cancelación de oficina', 'Cancelación de domicilio', 'Pérdida de unipersonalidad',
    'Pérdida de la condición de unipersonal', 'Cierre provisional de hoja registral',
    'Cierre de hoja registral', 'Conversión en sucursal', 'Traslado del domicilio social',
    'Reapertura de hoja registral', 'Pagos por acciones', 'Autoliquidación',
    'Solicitud de suspensión del plazo', 'Consolidación de la situación',
]

# tipo_acto singular sin acentos — valores EXACTOS del dataset upstream
# (nombramiento 10.2M, cese 3.7M, revocacion 2.4M, reeleccion 741K, cancelacion 64K).
TIPO_ACTO = {
    'Nombramientos': 'nombramiento',
    'Reelecciones': 'reeleccion',
    'Revocaciones': 'revocacion',
    'Ceses/Dimisiones': 'cese',
    'Cancelación de oficina': 'cancelacion',
    'Cancelación de domicilio': 'cancelacion',
}
CARGO_HEADERS = set(TIPO_ACTO)  # los que traen «Cargo: A;B.» parseable

_DATOS_RE = re.compile(
    r'Datos registrales\.\s*T\s*([\d.]+)\s*,\s*F\s*([\d.]+)\s*,\s*S\s*(\d+)\s*,'
    r'\s*H\s*([A-Z0-9]+)\s*([\d.]+)?\s*,\s*I/A\s*([A-Z\d.]+)\s*(?:\(([\d.]+)\))?'
)
# Grupo de cargo: «Adm. Unico: A;B.» — el punto de abreviatura DENTRO del
# cargo se permite si va seguido de espacio+mayúscula (mirando al frente):
# «Adm. Unico» ✓; y punto final opcional antes de ':' («Apo. Sol.: A») se
# recorta después con strip('.'). Sin lexico: cubre Adm./Apo./SOL./MANCOM./etc.
_CARGO_GRUPO_RE = re.compile(
    r'((?:[^.:]|\.(?=\s*[A-ZÁÉÍÓÚÜÑ])){2,60}?\.?):\s*([^.]+?)\s*(?:\.|$)'
)
_ACTO_HEADERS_LOW = {h.lower() for h in ACTO_HEADERS} | {'datos registrales'}


def _parse_datos_registrales(text: str) -> dict:
    m = _DATOS_RE.search(text)
    if not m:
        return {}
    tomo, folio, seccion, hoja_letra, hoja_num, insc, fecha_insc = m.groups()
    out = {'tomo': tomo.replace('.', '') or None}
    if hoja_letra and hoja_num:
        out['hoja_registral'] = f"{hoja_letra} {hoja_num.replace('.', '')}"
    elif hoja_letra:
        out['hoja_registral'] = hoja_letra
    out['inscripcion'] = (insc or '').replace('.', '') or None
    if fecha_insc:
        p = [x for x in fecha_insc.split('.') if x]
        if len(p) == 3:
            yy = int(p[2])
            year = 2000 + yy if yy < 50 else 1900 + yy
            out['fecha_inscripcion'] = f"{p[0]}.{p[1].zfill(2)}.{p[2]}"
    return out


def _split_actos(text: str) -> list[tuple[str, str]]:
    """Divide un parrafo en segmentos (cabecera, contenido) por las cabeceras
    conocidas, en el orden del texto."""
    marks: list[tuple[int, str]] = []
    low = text
    for h in ACTO_HEADERS:
        start = 0
        while True:
            i = low.find(h + '.', start)
            if i < 0:
                break
            marks.append((i, h))
            start = i + len(h) + 1
    marks.sort()
    if not marks:
        return []
    segs = []
    for idx, (pos, h) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(text)
        segs.append((h, text[pos + len(h) + 1:end].strip()))
    return segs


def _parse_cargo_segment(content: str) -> list[tuple[str, list[str]]]:
    """«Adm. Unico: A;B. Apo. Sol.: C.» → [('Adm. Unico', [A,B]), ('Apo. Sol.', [C])]
    Los grupos cuyo «cargo» es en realidad una cabecera de acto anidada
    («Otros conceptos: …») se descartan: no son cargos."""
    out = []
    for m in _CARGO_GRUPO_RE.finditer(content):
        cargo = m.group(1).strip().strip('.')
        if cargo.lower() in _ACTO_HEADERS_LOW:
            continue
        personas = [p.strip() for p in m.group(2).split(';') if p.strip()]
        if cargo and personas:
            out.append((cargo, personas))
    return out


def parse_entrada(xml_bytes: bytes) -> dict | None:
    """Parsea el XML de una entrada BORME-A-YYYY-NNN-PP."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        print(f"  ⚠️  XML no parseable: {e}")
        return None
    meta = root.find('metadatos')
    if meta is None:
        return None
    ident = (meta.findtext('identificador') or '').strip()
    m = re.match(r'^BORME-A-\d{4}-(\d+)-(\d+)$', ident)
    if not m:
        return None
    out = {
        'identificador': ident,
        'num_borme': int(m.group(1)),
        'cod_provincia': m.group(2),
        'provincia': (meta.findtext('titulo') or '').strip().upper(),
        'fecha_publicacion': (meta.findtext('fecha_publicacion') or '').strip(),
        'pdf_filename': f"{ident}.pdf",
        'empresas': [],
    }
    texto = root.find('texto')
    if texto is None:
        return out
    current = None
    for p in texto.findall('p'):
        cls = p.get('class') or ''
        content = ' '.join((p.text or '').split())
        if not content:
            continue
        if cls == 'articulo':
            m2 = re.match(r'^(\d+) - (.+?)[.]?$', content)
            if m2:
                current = {
                    'num_entrada': m2.group(1),
                    'empresa': m2.group(2).strip(),
                    'actos_texto': [],
                    'registrales': {},
                    'capital_euros': None,
                    'domicilio': None,
                    'fecha_constitucion': None,
                    'cargos': [],
                }
                out['empresas'].append(current)
            continue
        if cls != 'parrafo' or current is None:
            continue
        for header, seg in _split_actos(content):
            current['actos_texto'].append(header)
            if header == 'Constitución':
                current['fecha_constitucion'] = current.get('_const_flag') or current['fecha_constitucion']
            for k, v in _parse_datos_registrales(seg or content).items():
                current['registrales'][k] = v
            cap = re.search(r'Resultante Suscrito:\s*([\d.,]+)\s*Euros', seg) or re.search(r'Capital:\s*([\d.,]+)\s*Euros', seg)
            if cap:
                try:
                    current['capital_euros'] = float(cap.group(1).replace('.', '').replace(',', '.'))
                except ValueError:
                    pass
            dom = re.search(r'(?:Domicilio|Nuevo domicilio social|Nuevo domicilio):\s*([^.]+)\.', seg)
            if dom:
                current['domicilio'] = dom.group(1).strip().upper()
            if header == 'Constitución':
                mcons = re.search(r'Inicio de operaciones:\s*([\d.]+)\.', seg)
                if mcons:
                    p = [x for x in mcons.group(1).split('.') if x]
                    if len(p) == 3:
                        yy = int(p[2])
                        year = 2000 + yy if yy < 50 else 1900 + yy
                        try:
                            current['fecha_constitucion'] = fmt_fecha_corta(date(year, int(p[1]), int(p[0])), True)
                        except ValueError:
                            pass
            if header in CARGO_HEADERS:
                for cargo, personas in _parse_cargo_segment(seg):
                    for persona in personas:
                        current['cargos'].append({
                            'tipo_acto': TIPO_ACTO[header],
                            'cargo': cargo,
                            'persona': persona,
                            'persona_hash': hash_persona(persona),
                        })
        # domicilio también aparece como acto «Cambio de domicilio social» ya
        # cubierto arriba; el «Datos registrales» del último parrafo gana.
    return out


def fetch_sumario(day: date) -> dict | None:
    xml = http_get(SUMARIO_URL.format(yyyymmdd=day.strftime('%Y%m%d')))
    if xml is None:
        return None
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    code = root.findtext('./status/code')
    if code != '200':
        return None  # día sin publicación
    out = {'items': [], 'num_borme': None}
    for diario in root.findall('./data/sumario/diario'):
        out['num_borme'] = diario.get('numero') or out['num_borme']
        for item in diario.findall('./seccion[@codigo="A"]/item'):
            ident = (item.findtext('identificador') or '').strip()
            if re.match(r'^BORME-A-\d{4}-\d+-\d+$', ident):
                out['items'].append(ident)
    return out


def fetch_entrada(ident: str, day: date) -> bytes | None:
    d = BORME_XML_DIR / day.strftime('%Y') / day.strftime('%m')
    d.mkdir(parents=True, exist_ok=True)
    cache = d / f"{ident}.xml"
    if cache.exists() and cache.stat().st_size > 0:
        return cache.read_bytes()
    xml = http_get(ENTRADA_URL.format(id=ident))
    if xml is not None:
        cache.write_bytes(xml)
        time.sleep(SLEEP_BETWEEN_REQUESTS)
    return xml


def ensure_borme_personas(con) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS borme_personas (
            persona_hash VARCHAR,
            nombre VARCHAR,
            fuente VARCHAR DEFAULT 'borme-xml-diario',
            actualizado TIMESTAMP DEFAULT now()
        )
    """)


def day_already_loaded(con, day: date) -> bool:
    row = con.execute(
        "SELECT 1 FROM borme_empresas WHERE fecha_borme = ? LIMIT 1",
        [datetime(day.year, day.month, day.day)]
    ).fetchone()
    return row is not None


def insert_day(con, day: date, entradas: list[dict]) -> tuple[int, int, int]:
    """INSERT de empresas+cargos+personas del día. Idempotente: la llamada
    previa day_already_loaded evita duplicados."""
    n_emp = n_car = n_per = 0
    personas = {}
    emp_rows, car_rows = [], []
    for e in entradas:
        if not e or not e.get('empresas'):
            continue
        fpub = e['fecha_publicacion']
        if fpub:
            p = [x for x in fpub.split('-') if x]  # 20261009 → no guiones
        reg_global = {}
        for emp in e['empresas']:
            reg = dict(emp['registrales'])
            fconst = emp.get('fecha_constitucion')
            actos_txt = '|'.join(emp['actos_texto']) if emp['actos_texto'] else None
            emp_rows.append((
                datetime(day.year, day.month, day.day), e['num_borme'],
                emp['num_entrada'], emp['empresa'],
                normalize_empresa(emp['empresa']),
                e['provincia'], e['cod_provincia'], 'A',
                actos_txt, emp.get('domicilio'), emp.get('capital_euros'),
                fconst, reg.get('hoja_registral'), reg.get('tomo'),
                reg.get('inscripcion'), reg.get('fecha_inscripcion'),
                e['pdf_filename'],
            ))
            for c in emp['cargos']:
                car_rows.append((
                    datetime(day.year, day.month, day.day), emp['num_entrada'],
                    emp['empresa'], normalize_empresa(emp['empresa']),
                    e['provincia'], reg.get('hoja_registral'),
                    c['tipo_acto'], c['cargo'], c['persona_hash'],
                    e['pdf_filename'],
                ))
                if c['persona_hash'] and c['persona']:
                    personas.setdefault(c['persona_hash'], c['persona'])
            n_emp += 1
            n_car += len(emp['cargos'])
        reg_global.update(reg)
    if not emp_rows:
        return 0, 0, 0
    con.executemany(
        """INSERT INTO borme_empresas (
            fecha_borme, num_borme, num_entrada, empresa, empresa_norm,
            provincia, cod_provincia, tipo_borme, actos, domicilio,
            capital_euros, fecha_constitucion, hoja_registral, tomo,
            inscripcion, fecha_inscripcion, pdf_filename)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        emp_rows,
    )
    if car_rows:
        con.executemany(
            """INSERT INTO borme_cargos (
                fecha_borme, num_entrada, empresa, empresa_norm, provincia,
                hoja_registral, tipo_acto, cargo, persona_hash, pdf_filename)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            car_rows,
        )
    if personas:
        existing = {r[0] for r in con.execute(
            "SELECT persona_hash FROM borme_personas WHERE persona_hash IN ("
            + ','.join('?' * len(personas)) + ")",
            list(personas.keys()),
        ).fetchall()}
        nuevos = [(h, n) for h, n in personas.items() if h not in existing]
        if nuevos:
            con.executemany(
                "INSERT INTO borme_personas (persona_hash, nombre) VALUES (?, ?)",
                nuevos,
            )
            n_per = len(nuevos)
    return n_emp, n_car, n_per


def catch_up_xml(con) -> None:
    ensure_borme_personas(con)
    start = db_max_fecha(con)
    if start is None:
        print("[xml] BD BORME vacía — el XML diario parte del snapshot; sin catch-up")
        return
    hoy = date.today()
    max_dias = BORME_MAX_XML_DAYS
    candidatos: list[date] = []
    d = start + timedelta(days=1)
    while d <= hoy and len(candidatos) < max_dias:
        if d.weekday() < 6:  # BORME publica lun-vie (sáb excepcional: se intenta igualmente vía API)
            candidatos.append(d)
        d += timedelta(days=1)
    if not candidatos:
        print(f"[xml] sin días pendientes (BD al día hasta {start})")
        return
    print(f"[xml] días pendientes (máx {max_dias}): {[c.isoformat() for c in candidatos]}")
    for day in candidatos:
        if day_already_loaded(con, day):
            print(f"  {day}: ya cargado — skip")
            continue
        sumario = fetch_sumario(day)
        if not sumario or not sumario['items']:
            print(f"  {day}: sin entradas publicadas (festivo/fin de semana)")
            continue
        print(f"  {day}: {len(sumario['items'])} entradas (diario nº {sumario.get('num_borme')})")
        n_emp = n_car = n_per = 0
        for ident in sumario['items']:
            xml = fetch_entrada(ident, day)
            if xml is None:
                continue
            parsed = parse_entrada(xml)
            if parsed is not None:
                a, b, c = insert_day(con, day, [parsed])
                n_emp += a
                n_car += b
                n_per += c
        print(f"  ✅ {day}: +{n_emp} empresas, +{n_car} cargos, +{n_per} nombres")


def main() -> None:
    argv = sys.argv[1:]
    skip_parquet = '--xml-only' in argv
    skip_xml = '--parquet-only' in argv
    print(f"== BORME incremental sobre {DB_PATH} ==")
    con = duckdb.connect(DB_PATH)
    try:
        if not skip_parquet:
            try:
                refresh_from_parquet(con)
            except Exception as e:  # noqa: BLE001 — el paso XML sigue después
                print(f"[parquet] ERROR (no fatal): {e}")
        if not skip_xml:
            try:
                catch_up_xml(con)
            except Exception as e:  # noqa: BLE001
                print(f"[xml] ERROR (no fatal): {e}")
        mx = db_max_fecha(con)
        print(f"== fin: borme_empresas hasta {mx} ==")
    finally:
        con.close()


if __name__ == '__main__':
    main()
