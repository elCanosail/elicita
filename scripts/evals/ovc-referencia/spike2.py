#!/usr/bin/env python3
"""Spike OVC final: ref catastral -> atributos físicos mapeables al motor.

Flujo: ConsultaNumero (14 chars de parcela) -> Consulta_DNPRC (ficha completa)
-> calibración empírica del checksum con las refs que devuelve el servicio
-> estrés con ref inválida.
"""
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BASE = ("https://ovc.catastro.meh.es/ovcservweb/"
        "OVCSWLocalizacionRC/OVCCallejero.asmx")


def get(path, **params):
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{BASE}/{path}?{qs}",
                                 headers={"User-Agent": "Mozilla/5.0"})
    try:
        return urllib.request.urlopen(req, timeout=30).read().decode(
            "utf-8", "replace")
    except urllib.error.HTTPError as e:
        return f"HTTP{e.code}: " + e.read().decode("utf-8", "replace")


# --- 1. Cosechar refs de parcela (14 chars) en Sevilla -------------------
refs14 = []
for via, num in [("Constitución", "1"), ("Constitución", "25"),
                 ("Triana", "45"), ("Reyes Católicos", "20")]:
    v = get("ConsultaVia", Provincia="Sevilla", Municipio="Sevilla",
            TipoVia="", NombreVia=via)
    m = re.search(r"<cv>(\d+)</cv>", v)
    if not m:
        print(f"  via falla {via}: {v[:120]}")
        continue
    tvia = (re.search(r"<tv>(\w+)</tv>", v) or [None, ""])[1]
    nvia = (re.search(r"<nv>([^<]+)</nv>", v) or [None, ""])[1]
    n = get("ConsultaNumero", Provincia="Sevilla", Municipio="Sevilla",
            TipoVia=tvia, NomVia=nvia, Numero=num)
    pares = re.findall(r"<pc1>(\w{7})</pc1>\s*<pc2>(\w{7})</pc2>", n)
    refs14 += [a + b for a, b in pares[:4]]
    print(f"  {via} {num}: {len(pares[:4])} refs de parcela")
    time.sleep(0.5)

refs14 = list(dict.fromkeys(refs14))[:12]
print(f"\n{len(refs14)} refs cosechadas")


# --- 2. DNPRC de cada una + recolectar refs completas (20 chars) ----------
def parse_rc(xml_text):
    """refs completas (18 chars + control) y campos de interés del XML."""
    out = {"refs": [], "campos": {}}
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return out
    for rc in root.iter("{http://www.catastro.meh.es/}rc"):
        g = lambda t: (rc.find(f"{{http://www.catastro.meh.es/}}{t}") is not None
                       and rc.find(f"{{http://www.catastro.meh.es/}}{t}").text or "")
        pc1, pc2, car = g("pc1"), g("pc2"), g("car")
        if pc1 and pc2 and car:
            out["refs"].append(pc1 + pc2 + car
                               + (g("cc1") + g("cc2")))
    for el in root.iter():
        t = el.tag.split("}")[-1]
        if t in ("ldt", "luso", "sfc", "sfp", "antiguedad", "ybi", "mybi",
                 "ycon", "mycon", "cn", "cdl", "efector", "pcs") and el.text:
            out["campos"].setdefault(t, set()).add(el.text.strip()[:90])
    return out


fichas, validas = [], []
for r14 in refs14:
    d = get("Consulta_DNPRC", Provincia="Sevilla", Municipio="Sevilla", RC=r14)
    p = parse_rc(d)
    fichas.append((r14, p))
    validas += p["refs"]
    time.sleep(0.5)

validas = list(dict.fromkeys(validas))
print(f"{len(validas)} refs completas (20 chars) recolectadas del DNPRC")
for r14, p in fichas[:3]:
    print(f"  {r14}: {p['campos']}")


# --- 3. Checksum: calibración empírica ------------------------------------
def control(ref18, mapa):
    pesos = [13, 7, 9, 5, 4, 14, 9]
    try:
        d = [int(c) for c in ref18[0:7]]
    except ValueError:
        return None
    s = sum(v * p for v, p in zip(d, pesos))
    r = 11 - (s % 11)
    c1 = mapa.get(r, str(r))
    try:
        d2 = [int(c) for c in ref18[14:18]] + [int(c1)]
    except ValueError:
        return None
    s2 = sum(v * p for v, p in zip(d2, [13, 7, 9, 5, 4]))
    r2 = 11 - (s2 % 11)
    return c1 + mapa.get(r2, str(r2))


for nombre, mapa in [("10->1,11->0", {10: "1", 11: "0"}),
                     ("10->Y,11->B", {10: "Y", 11: "B"}),
                     ("10->0,11->0", {10: "0", 11: "0"})]:
    ok = sum(1 for r in validas if control(r[:18], mapa) == r[18:20])
    print(f"checksum {nombre}: {ok}/{len(validas)}")


# --- 4. Estrés: ref con control erróneo ------------------------------------
if validas:
    mala = validas[0][:18] + ("00" if validas[0][18:20] != "00" else "99")
    r = get("Consulta_DNPRC", Provincia="Sevilla", Municipio="Sevilla", RC=mala[:14])
    print(f"\nestrés ref malcontrolada: {r[:220]}")
