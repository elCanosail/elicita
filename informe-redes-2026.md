# Informe de licitaciones concedidas por Red.es (2016-2026)

**Fecha de generación:** Junio 2026  
**Fuente:** Base de datos DuckDB de Elicita (`/var/data/licitaciones/db/licitaciones.duckdb`)  
**Entidad analizada:** Entidad Pública Empresarial Red.es (Dirección General de RED.ES / Dirección General de la Entidad Pública Empresarial RED.ES)  
**Período:** 1 de enero de 2016 – 9 de junio de 2026 (última actualización de la base de datos)

---

## Resumen ejecutivo

Durante el período 2016-2026, **Red.es** ha publicado en las plataformas de contratación pública analizadas un total de **3,318 resoluciones de adjudicación**, con un **importe total adjudicado de 4.355.452.984,69 €**.

- **Plataforma nacional (contrataciondelestado.es):** 740 contratos, 785.854.174,89 €.
- **TED (Tenders Electronic Daily – UE):** 2,578 anuncios de adjudicación, 3.569.598.809,80 €.

> **Nota metodológica:** las tablas `nacional` y `ted` no son disjuntas. Muchos expedientes aparecen en ambas fuentes (nacional y TED), por lo que la suma directa de contratos e importes puede contener duplicados. No obstante, cada tabla aporta información complementaria: la nacional aporta datos de importes sin IVA y procedimientos en formato español, mientras que TED aporta detalles de adjudicación europea.

---

## Metodología

1. **Conexión:** se accedió en modo solo lectura a `/var/data/licitaciones/db/licitaciones.duckdb` mediante el driver Python de DuckDB.
2. **Tablas utilizadas:**
   - `nacional`: perfiles de contratante del Estado español (Portal de Contratación del Sector Público).
   - `ted`: anuncios de adjudicación publicados en el Supplemento del Diario Oficial de la UE (TED).
3. **Criterio de búsqueda:** se filtró por `organo_contratante` (y `CAE_NAME` en TED) utilizando patrones insensibles a mayúsculas:
   - `%red.es%`, `%red es%`, `%red electronica%`
   - Se **excluyeron** falsos positivos: `retegal`, `redes digitales`, `gas natural`, `distribuci`.
4. **Estado:** solo contratos en estado `Adjudicada` (nacional) o `Adjudicada`/`Resuelta` con importe de adjudicación positivo (TED).
5. **Período:** `YEAR(fecha_publicacion)` / `ano` entre 2016 y 2026.
6. **Importes:** en la tabla nacional se usó `importe_adjudicacion`; en TED también `importe_adjudicacion`. Ambos importes se expresan en euros.
7. **Limitaciones:**
   - La base de datos no distingue automáticamente entre contratos con y sin IVA en la columna `importe_adjudicacion`; por ello los importes deben interpretarse como valores nominales.
   - La tabla TED contiene múltiples registros por lote/adjudicatario para un mismo expediente, por lo que los top 20 TED muestran duplicados que han sido deduplicados en este informe.
   - Algunos adjudicatarios aparecen con distintas grafías del mismo nombre (p. ej. "TELEFÓNICA DE ESPAÑA, S.A.U." vs "TELEFONICA DE ESPAÑA, S.A.U."), lo que dispersa el agrupamiento.
   - 2026 está incompleto (hasta junio).

---

## Evolución anual (nacional + TED combinado)

| Año | Contratos | Importe adjudicado (M€) | Importe medio (M€) |
|-----|-----------:|------------------------:|---------------------:|
| 2016 | 212 | 528.30 | 2.49 |
| 2017 | 414 | 247.66 | 0.60 |
| 2018 | 19 | 253.82 | 13.36 |
| 2019 | 74 | 168.14 | 2.27 |
| 2020 | 578 | 963.40 | 1.67 |
| 2021 | 664 | 970.36 | 1.46 |
| 2022 | 380 | 473.94 | 1.25 |
| 2023 | 542 | 442.39 | 0.82 |
| 2024 | 230 | 159.89 | 0.70 |
| 2025 | 205 | 147.56 | 0.72 |

**Observaciones:**
- El año con mayor número de resoluciones es **2021** (664 contratos), impulsado por los programas de conectividad educativa ("Escuelas Conectadas", "Kit Digital").
- El año con mayor importe adjudicado es **2020**, con 963,40 M€, seguido de 2021.
- Se observa un descenso progresivo a partir de 2022, tanto en número de contratos como en importe.

---

## Distribución por tipo de contrato (plataforma nacional)

| Tipo de contrato | Contratos | Importe total (M€) |
|------------------|-----------:|-------------------:|
| Servicios        | 536 | 300,01 |
| Suministros      | 204 | 485,85 |

- Los **servicios** concentran el 72 % de los contratos nacionales pero solo el 38 % del importe.
- Los **suministros** suponen el 28 % de los contratos y el 62 % del importe, explicado por grandes contratos de equipamiento tecnológico y conectividad.

---

## Procedimiento de contratación (plataforma nacional)

| Procedimiento | Contratos | Importe total (M€) |
|---------------|-----------:|-------------------:|
| Abierto | 616 | 721,23 |
| Basado en sistema dinámico | 69 | 3,05 |
| Negociado con publicidad | 50 | 19,78 |
| Diálogo competitivo | 3 | 40,08 |
| Contrato menor | 2 | 1,72 |

- El **procedimiento abierto** es el dominante: 83 % de los contratos y 92 % del importe.

---

## Top 20 adjudicatarios por número de contratos (TED)

| Pos. | Adjudicatario | Contratos | Importe total (M€) |
|------|---------------|-----------:|-------------------:|
| 1 | TELEFONICA SOLUCIONES DE INFORMATICA Y COMUNICACIONES DE ESP | 76 | 169,01 |
| 2 | UTE INNOVA NEXT, S.L.U. Y THE VALLEY DIGITAL BUSINESS SCHOOL | 66 | 163,65 |
| 3 | TELEFONICA DE ESPAÑA, S.A.U. | 58 | 35,64 |
| 4 | LYNTIA NETWORKS SAU | 57 | 20,99 |
| 5 | OESIA NETWORKS, S.L. | 45 | 32,26 |
| 6 | TELEFÓNICA SOLUCIONES DE INFORMÁTICA Y COMUNICACIONES DE ESP | 45 | 35,84 |
| 7 | UTE TELEFÓNICA MÓVILES ESPAÑA, S.A.U. - TELEFÓNICA SOLUCIONE | 45 | 182,70 |
| 8 | PACKET CLEARING HOUSE | 44 | 5,78 |
| 9 | ORANGE ESPAGNE, S.A.U. | 42 | 173,06 |
| 10 | TELECYL, S.A | 41 | 10,00 |
| 11 | EY TRANSFORMA SERVICIOS DE CONSULTORÍA, S.L. | 37 | 26,10 |
| 12 | EVERIS SPAIN, S.L. | 33 | 15,45 |
| 13 | NTT DATA SPAIN, S.L.U. | 32 | 27,97 |
| 14 | CAJA DE SEGUROS REUNIDOS COMPAÑÍA DE SEGUROS Y REASEGUROS S. | 31 | 0,41 |
| 15 | UTE TELEFÓNICA SOLUCIONES DE INFORMÁTICA Y COMUNICACIONES DE | 30 | 195,10 |
| 16 | NEORIS ESPAÑA SLU | 30 | 20,06 |
| 17 | CENTRO REGIONAL DE SERVICIOS AVANZADOS, S.A. | 26 | 8,05 |
| 18 | COMPUSOF S.A. | 24 | 6,60 |
| 19 | ORANGE ESPAGNE S.A.U | 24 | 51,62 |
| 20 | COMPUSOF, S.A. | 23 | 6,92 |

---

## Top 20 adjudicatarios por importe total (TED)

| Pos. | Adjudicatario | Contratos | Importe total (M€) |
|------|---------------|-----------:|-------------------:|
| 1 | TELEFÓNICA DE ESPAÑA, S.A.U. | 21 | 275,67 |
| 2 | SISTEMAS INFORMATICOS ABIERTOS, S.A. | 16 | 213,74 |
| 3 | UTE TELEFÓNICA SOLUCIONES DE INFORMÁTICA Y COMUNICACIONES DE | 30 | 195,10 |
| 4 | UTE TELEFÓNICA MÓVILES ESPAÑA, S.A.U. - TELEFÓNICA SOLUCIONE | 45 | 182,70 |
| 5 | ORANGE ESPAGNE, S.A.U. | 42 | 173,06 |
| 6 | TELEFONICA SOLUCIONES DE INFORMATICA Y COMUNICACIONES DE ESP | 76 | 169,01 |
| 7 | UTE INNOVA NEXT, S.L.U. Y THE VALLEY DIGITAL BUSINESS SCHOOL | 66 | 163,65 |
| 8 | UTE NTT DATA SPAIN - NTT DATA SPAIN BPO - OESIA NETWORKS | 6 | 148,74 |
| 9 | VODAFONE ESPAÑA, S.A.U | 10 | 87,50 |
| 10 | ORANGE ESPAGNE, S.A.U | 18 | 77,84 |
| 11 | INUSUAL COMUNICACIÓN INNOVADORA, S.L. | 9 | 71,08 |
| 12 | ORANGE ESPAGNE S.A.U | 24 | 51,62 |
| 13 | EY TRANSFORMA SERVICIOS DE CONSULTORIA S.L. | 6 | 50,15 |
| 14 | UTE THE VALLEY DIGITAL BUSINESS SCHOOL, S.L. – INNOVA NEXT,  | 13 | 47,27 |
| 15 | Orange Espagne, S.A.U. | 3 | 43,91 |
| 16 | TELEFONICA SOLUCIONES DE INFORMATICA Y COMUNICACIONES DE ESP | 15 | 41,77 |
| 17 | TELEFÓNICA DE ESPAÑA, S.A.U | 6 | 41,53 |
| 18 | HEALTHCARE PROVIDER SOFTWARE SPAIN S.L.U. – CORE & GLOBAL IT | 6 | 41,39 |
| 19 | TELEFONICA SOLUCIONES DE  INFORMATICA Y COMUNICACIONES DE ES | 12 | 40,66 |
| 20 | ALGORITMOS PROCESOS Y  DISEÑOS, S.A. | 6 | 38,70 |

---

## Top 20 adjudicatarios por número de contratos (plataforma nacional)

| Pos. | Adjudicatario | Contratos | Importe total (M€) |
|------|---------------|-----------:|-------------------:|
| 1 | TELEFONICA SOLUCIONES DE INFORMATICA Y COMUNICACIONES DE ESP | 18 | 39,87 |
| 2 | TELEFONICA DE ESPAÑA, S.A.U. | 17 | 10,00 |
| 3 | OESIA NETWORKS, S.L. | 15 | 7,52 |
| 4 | LYNTIA NETWORKS SAU | 13 | 4,91 |
| 5 | PACKET CLEARING HOUSE | 12 | 1,58 |
| 6 | UTE INNOVA NEXT, S.L.U. Y THE VALLEY DIGITAL BUSINESS SCHOOL | 11 | 27,27 |
| 7 | ORANGE ESPAGNE, S.A.U. | 10 | 36,17 |
| 8 | TELEFÓNICA SOLUCIONES DE INFORMÁTICA Y COMUNICACIONES DE ESP | 10 | 7,55 |
| 9 | QUALITY MEDIA PRODUCCIONES SL | 10 | 0,15 |
| 10 | TELECYL, S.A | 10 | 1,87 |
| 11 | CAJA DE SEGUROS REUNIDOS COMPAÑÍA DE SEGUROS Y REASEGUROS S. | 9 | 0,12 |
| 12 | EY TRANSFORMA SERVICIOS DE CONSULTORÍA, S.L. | 8 | 6,86 |
| 13 | EVERIS SPAIN, S.L. | 8 | 3,49 |
| 14 | UTE TELEFÓNICA MÓVILES ESPAÑA, S.A.U. - TELEFÓNICA SOLUCIONE | 8 | 57,10 |
| 15 | COMPUSOF, S.A. | 7 | 1,55 |
| 16 | NTT DATA SPAIN, S.L.U. | 6 | 4,78 |
| 17 | ICLAVES S.L | 6 | 0,50 |
| 18 | KPMG Asesores, S.L. | 6 | 0,38 |
| 19 | D'ALEPH INICIATIVAS Y ORGANIZACIÓN S.A. | 6 | 2,80 |
| 20 | TELEFÓNICA DE ESPAÑA, S.A.U. | 6 | 47,92 |

---

## Top 20 adjudicatarios por importe total (plataforma nacional)

| Pos. | Adjudicatario | Contratos | Importe total (M€) |
|------|---------------|-----------:|-------------------:|
| 1 | UTE TELEFÓNICA MÓVILES ESPAÑA, S.A.U. - TELEFÓNICA SOLUCIONE | 8 | 57,10 |
| 2 | TELEFÓNICA DE ESPAÑA, S.A.U. | 6 | 47,92 |
| 3 | SISTEMAS INFORMATICOS ABIERTOS, S.A. | 3 | 40,08 |
| 4 | TELEFONICA SOLUCIONES DE INFORMATICA Y COMUNICACIONES DE ESP | 18 | 39,87 |
| 5 | ORANGE ESPAGNE, S.A.U. | 10 | 36,17 |
| 6 | UTE TELEFÓNICA SOLUCIONES DE INFORMÁTICA Y COMUNICACIONES DE | 5 | 32,52 |
| 7 | UTE INNOVA NEXT, S.L.U. Y THE VALLEY DIGITAL BUSINESS SCHOOL | 11 | 27,27 |
| 8 | UTE NTT DATA SPAIN - NTT DATA SPAIN BPO - OESIA NETWORKS | 1 | 24,79 |
| 9 | INUSUAL COMUNICACIÓN INNOVADORA, S.L. | 3 | 23,69 |
| 10 | VODAFONE ESPAÑA, S.A.U | 2 | 17,50 |
| 11 | Orange Espagne, S.A.U. | 1 | 14,64 |
| 12 | TELEFÓNICA DE ESPAÑA, S.A.U | 2 | 13,84 |
| 13 | ORANGE ESPAGNE, S.A.U | 3 | 12,97 |
| 14 | UTE EVERIS BPO, S.L.U.- EVERIS SPAIN, S.L.U. – OESÍA NETWORK | 1 | 11,00 |
| 15 | UTE THE VALLEY DIGITAL BUSINESS SCHOOL, S.L. – INNOVA NEXT,  | 3 | 10,91 |
| 16 | TELEFONICA DE ESPAÑA, S.A.U. | 17 | 10,00 |
| 17 | SISTEMAS INFORMÁTICOS ABIERTOS, S.A. | 1 | 9,80 |
| 18 | Guadaltel, S.A | 5 | 9,75 |
| 19 | SISTEMAS INFORMATICOS ABIERTOS, S.A | 3 | 8,65 |
| 20 | ORANGE ESPAGNE S.A.U | 4 | 8,60 |

---

## Contratos de mayor importe (plataforma nacional)

| Pos. | Expediente | Adjudicatario | Importe (M€) | Año | Objeto |
|------|------------|---------------|-------------:|-----|--------|
| 1 | 002/21-SP | UTE TELEFÓNICA MÓVILES ESPAÑA, S.A.U. - TELEF | 53,29 | 2021 | Suministro de soluciones de puesto educativo en el hogar para centros educativos |
| 2 | 076/16-SV | TELEFÓNICA DE ESPAÑA, S.A.U. | 40,05 | 2016 | Escuelas conectadas Andalucía |
| 3 | 050/23-SI | UTE NTT DATA SPAIN - NTT DATA SPAIN BPO - OES | 24,79 | 2023 | Servicio de soporte a la gestión de convocatorias y convenios para el desarrollo |
| 4 | 053/16-SV | Orange Espagne, S.A.U. | 14,64 | 2016 | Escuelas conectadas Galicia |
| 5 | 004/18-RI | SISTEMAS INFORMATICOS ABIERTOS, S.A. | 13,36 | 2018 | Contrato de suministro de equipamiento óptico para la renovación tecnológica de  |
| 6 | 072/16-SV | TELEFÓNICA DE ESPAÑA, S.A.U | 11,81 | 2017 | Escuelas conectadas Canarias |
| 7 | 075/21-SI | UTE EVERIS BPO, S.L.U.- EVERIS SPAIN, S.L.U.  | 11,00 | 2021 | Servicio de soporte a la gestión de convocatorias, expedientes y convenios para  |
| 8 | 062/21-SI | SISTEMAS INFORMÁTICOS ABIERTOS, S.A. | 9,80 | 2022 | Suministro y gestión de una solución para la explotación de sistemas en Cloud |
| 9 | 070/16-SV | VODAFONE ESPAÑA, S.A.U | 8,75 | 2016 | Escuelas conectadas Murcia |
| 10 | 093/20-SP | ORANGE ESPAGNE, S.A.U | 8,42 | 2020 | Suministro de soluciones de puesto educativo en el hogar para centros educativos |
| 11 | 012-22-ED | EY TRANSFORMA SERVICIOS DE CONSULTORIA S.L. | 8,36 | 2022 | Servicio de soporte y apoyo técnico y administrativo para el desarrollo de los p |
| 12 | 020/22-SP | INUSUAL COMUNICACIÓN INNOVADORA, S.L. | 7,90 | 2022 | Suministro de armarios de carga para centros educativos de Andalucía, Aragón, As |
| 13 | 040/20-SP | NUNSYS, S.L | 7,21 | 2020 | Suministro de una solución de redes internas inalámbricas para el proyecto escue |
| 14 | 039/21-SP | HEALTHCARE PROVIDER SOFTWARE SPAIN S.L.U. – C | 6,90 | 2021 | Servicio para la implantación de una solución corporativa para el seguimiento pr |
| 15 | 061/21-SP | UTE TELEFONICA SOLUCIONES DE INFORMATICA Y CO | 6,63 | 2021 | Suministro de soluciones de puesto educativo en el hogar para centros educativos |

---

## Contratos de mayor importe (TED, deduplicados por expediente)

| Pos. | Expediente | Adjudicatario | Importe (M€) | Año | Objeto |
|------|------------|---------------|-------------:|-----|--------|
| 1 | 002/21-SP | UTE TELEFÓNICA MÓVILES ESPAÑA, S.A.U. - TELEF | 53,29 |  | Dirección General de la Entidad Pública Empresarial RED.ES |
| 2 | 076/16-SV | TELEFÓNICA DE ESPAÑA, S.A.U. | 40,05 |  | Dirección General de la Entidad Pública Empresarial RED.ES |
| 3 | 050/23-SI | UTE NTT DATA SPAIN - NTT DATA SPAIN BPO - OES | 24,79 |  | Dirección General de la Entidad Pública Empresarial RED.ES |
| 4 | 053/16-SV | Orange Espagne, S.A.U. | 14,64 |  | Dirección General de RED.ES |
| 5 | 004/18-RI | SISTEMAS INFORMATICOS ABIERTOS, S.A. | 13,36 |  | Dirección General de la Entidad Pública Empresarial RED.ES |

---

## Duración de los contratos

### Nacional (top 15 combinaciones duración/unidad)

| Duración | Unidad | Contratos |
|----------|--------|----------:|
| 24 meses | MON | 146 |
| 12 meses | MON | 142 |
| 36 meses | MON | 61 |
| 6 meses | MON | 49 |

La duración más habitual es **24 meses** (146 contratos), seguida de **12 meses** (142 contratos). La duración media no se calcula por la heterogeneidad de unidades (meses/años).

---

## Conclusiones

1. **Red.es es un adjudicador tecnológico relevante:** con más de 3.300 resoluciones de adjudicación en 10 años y más de 4.350 M€ en importes (suma nacional+TED, con solapamientos), su actividad refleja los grandes programas de digitalización del Estado español.

2. **Los programas de conectividad educativa marcan el ciclo:** los años 2020-2021 concentran el pico de actividad, vinculado a contratos de "Escuelas Conectadas", "Kit Digital" y suministro de equipamiento durante la pandemia.

3. **Concentración de operadores tecnológicos:** Telefónica, Orange, Vodafone, NTT Data / Oesía, Everis y EY concentran una parte muy significativa de los contratos. Las UTEs entre grandes operadores son frecuentes.

4. **Servicios vs. suministros:** aunque la mayoría de contratos son de servicios, los suministros de equipamiento y conectividad concentran la mayor parte del importe.

5. **Calidad de datos y duplicados:** el análisis requiere limpieza adicional (normalización de nombres de adjudicatarios, deduplicación entre nacional y TED, homogeneización de importes con/sin IVA) para obtener cifras consolidadas exactas.

---

## Anexos

- **Archivo de datos crudos:** `projects/elicita/informe-redes-data.json`
- **Consultas:** realizadas directamente sobre las tablas `nacional` y `ted` de DuckDB con filtros `ILIKE` y exclusión de falsos positivos.
