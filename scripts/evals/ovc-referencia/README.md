# Spike OVC: referencia catastral → atributos físicos para el motor de valoración

## Verdict: VALIDATED

Question: ¿Qué devuelve el OVC del Catastro para una referencia catastral, y mapea a
los factores del motor de valoración (año, superficie, uso, plantas)?

Evidence (2026-09-21, Sevilla):
- Contrato real (GET, HTTPS obligatorio — http:// devuelve 400/500 silencioso):
  1. `OVCCallejero.asmx/ConsultaVia?Provincia=Sevilla&Municipio=Sevilla&TipoVia=&NombreVia=...`
     → `<cv>` código de vía, `<tv>`/`<nv>` nombres normalizados
  2. `OVCCallejero.asmx/ConsultaNumero?...&TipoVia=<tv>&NomVia=<nv>&Numero=<n>`
     (TipoVia/NomVia EXIGIDOS aunque haya CodigoVia; Provincia/Municipio por nombre o código)
     → parcelas como `<pc1>4922701</pc1><pc2>TG3442B</pc2>` (14 chars)
  3. `OVCCallejero.asmx/Consulta_DNPRC?Provincia=&Municipio=&RC=<ref14 o 20>`
- Ficha DNPRC (tags): `bico/bi/debi/` → `<ant>1930</ant>` (AÑO CONSTRUCCIÓN),
  `<luso>Oficinas</luso>` (uso), `<sfc>5600</sfc>` (m² construidos),
  `<cpt>` (coeficiente), y `lcons/cons/` con desglose por planta (`<pt>`: -1,00,01...)
  y superficie por construcción (`<stl>`).
  MAPEO AL MOTOR: ant→yearFactor · sfc→superficie · luso→tipología · pt→planta
  · anexos por `<car>` de subparcelas (garaje/trastero).
- Estrés: RC malformada → error controlado cod 6 ("ERROR AL CONSULTAR LA
  REFERENCIA"), sin 500. Ref de 14 chars es suficiente para ficha; la ref de 20
  la devuelve el servicio con sus control canónicos (`cc1/cc2`, letras).

What worked: contrato completo en 4 llamadas; año/uso/superficie/plantas confirmados
con datos reales de Sevilla; errores controlados del servicio.

What failed or surprised us:
- http:// no sirve; parámetros exactos solo visibles por error-respuesta iterativa.
- El algoritmo de control (cc1/cc2, alfanuméricos — Y,B,L,G...) no calibró con
  2 rondas de fuerza bruta (19 refs reales). Pista: alfabeto en orden QWERTY
  (P,A,S,D,F,G consecutivos con car consecutivos).
- Wikipedia no tiene el artículo; el manual shapefile oficial no documenta el
  algoritmo de control.

Recommendation: SHIP (con ajuste) — integrar OVC en la tool de valoración con:
1. Validación: formato (14+4+2) + validación fuerte CONTRA EL SERVICIO: consultar
   la parcela (14 chars) y comparar cc1/cc2 canónicos que devuelve; sin algoritmo
   local. Fallback: flujo actual si el servicio no responde.
2. Caché DuckDB local por ref (ant/luso/sfc/plantas), degradación elegante.
3. Solo atributos físicos; ingesta por lotes para calibración (yearFactor v1.3).
Artefactos: /tmp/spike-ovc/spike2.py, /tmp/spike-ovc/dnprc-completo.txt
