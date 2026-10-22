-- ============================================================
-- contratos_unificados.sql
-- Vista unificada de todos los contratos de licitaciones
-- en DuckDB. Mapea cada tabla de fuente a columnas canónicas.
-- ============================================================

DROP VIEW IF EXISTS contratos_unificados;

CREATE VIEW contratos_unificados AS

-- nacional (13.4M) + calidad (8.7M) — PLACSP/PLACE
SELECT
  id,
  CASE
    WHEN archivo_origen LIKE '%PLACE%' OR archivo_origen LIKE '%place%' THEN 'PLACE'
    ELSE 'PLACSP'
  END AS fuente,
  expediente,
  organo_contratante AS organismo,
  objeto,
  COALESCE(
    NULLIF(TRIM(REPLACE(REPLACE(cpv_principal::VARCHAR, '.0', ''), ' ', '')), ''),
    NULLIF(TRIM(REPLACE(REPLACE(SPLIT_PART(cpvs, ',', 1), '.0', ''), ' ', '')), '')
  ) AS cpv,
  STRING_SPLIT(COALESCE(cpvs, cpv_principal::VARCHAR), ',') AS cpvs,
  COALESCE(importe_sin_iva, importe_con_iva, 0) AS importe_licitacion,
  COALESCE(importe_adjudicacion, importe_adj_con_iva, 0) AS importe_adjudicacion,
  LEAST(
    CAST(fecha_publicacion AS DATE),
    NULLIF(CAST(fecha_updated AS DATE), DATE '1970-01-01')
  ) AS fecha_publicacion,
  fecha_limite::DATE AS fecha_fin,
  url,
  COALESCE(estado, estado_code, 'Publicada') AS estado,
  adjudicatario,
  nif_adjudicatario
FROM nacional
WHERE id IS NOT NULL

UNION ALL

SELECT
  id,
  CASE
    WHEN archivo_origen LIKE '%PLACE%' OR archivo_origen LIKE '%place%' THEN 'PLACE'
    ELSE 'PLACSP'
  END AS fuente,
  expediente,
  organo_contratante AS organismo,
  objeto,
  COALESCE(
    NULLIF(TRIM(REPLACE(REPLACE(cpv_principal::VARCHAR, '.0', ''), ' ', '')), ''),
    NULLIF(TRIM(REPLACE(REPLACE(SPLIT_PART(cpvs, ',', 1), '.0', ''), ' ', '')), '')
  ) AS cpv,
  STRING_SPLIT(COALESCE(cpvs, cpv_principal::VARCHAR), ',') AS cpvs,
  COALESCE(importe_sin_iva, importe_con_iva, 0) AS importe_licitacion,
  COALESCE(importe_adjudicacion, importe_adj_con_iva, 0) AS importe_adjudicacion,
  LEAST(
    CAST(fecha_publicacion AS DATE),
    NULLIF(CAST(fecha_updated AS DATE), DATE '1970-01-01')
  ) AS fecha_publicacion,
  fecha_limite::DATE AS fecha_fin,
  url,
  COALESCE(estado, estado_code, 'Publicada') AS estado,
  adjudicatario,
  nif_adjudicatario
FROM calidad
WHERE id IS NOT NULL

UNION ALL

-- ted (6.5M) — European tenders
SELECT
  ID_NOTICE_CAN::VARCHAR AS id,
  'TED' AS fuente,
  COALESCE(expediente, ID_NOTICE_CAN::VARCHAR) AS expediente,
  CAE_NAME AS organismo,
  'Tender europeo' AS objeto,
  COALESCE(
    NULLIF(TRIM(REPLACE(REPLACE(CPV::VARCHAR, '.0', ''), ' ', '')), ''),
    NULLIF(TRIM(REPLACE(REPLACE(cpv_principal::VARCHAR, '.0', ''), ' ', '')), '')
  ) AS cpv,
  STRING_SPLIT(COALESCE(CPV::VARCHAR, cpv_principal::VARCHAR), ',') AS cpvs,
  COALESCE(CAST(VALUE_EURO_FIN_1 AS DOUBLE), importe_sin_iva, 0) AS importe_licitacion,
  COALESCE(CAST(AWARD_VALUE_EURO_FIN_1 AS DOUBLE), importe_adjudicacion, 0) AS importe_adjudicacion,
  TRY_STRPTIME(DT_DISPATCH, '%d-%b-%y')::DATE AS fecha_publicacion,
  TRY_STRPTIME(DT_AWARD, '%d-%b-%y')::DATE AS fecha_fin,
  NULL AS url,
  COALESCE(estado, 'Resuelta') AS estado,
  COALESCE(WIN_NAME, adjudicatario) AS adjudicatario,
  COALESCE(WIN_NATIONALID, nif_adjudicatario) AS nif_adjudicatario
FROM ted
WHERE ID_NOTICE_CAN IS NOT NULL

UNION ALL

-- andalucia (808K)
SELECT
  numero_expediente AS id,
  'ANDALUCIA' AS fuente,
  numero_expediente AS expediente,
  organo_contratacion AS organismo,
  titulo AS objeto,
  COALESCE(
    NULLIF(TRIM(REPLACE(REPLACE(cpv::VARCHAR, '.0', ''), ' ', '')), ''),
    NULLIF(TRIM(REPLACE(REPLACE(SPLIT_PART(cpv, ',', 1), '.0', ''), ' ', '')), '')
  ) AS cpv,
  STRING_SPLIT(cpv, ',') AS cpvs,
  COALESCE(importe_licitacion, 0) AS importe_licitacion,
  COALESCE(importe_adjudicacion, 0) AS importe_adjudicacion,
  TRY_CAST(fecha_publicacion AS DATE) AS fecha_publicacion,
  TRY_CAST(fecha_limite_presentacion AS DATE) AS fecha_fin,
  url_detalle AS url,
  COALESCE(estado, estado_codigo, 'Publicada') AS estado,
  NULL AS adjudicatario,
  adjudicatario_nif AS nif_adjudicatario
FROM andalucia
WHERE numero_expediente IS NOT NULL

UNION ALL

-- catalunya (2.5M) — múltiples formatos CSV: usar COALESCE sobre todos los campos alternativos
SELECT
  COALESCE(EXPEDIENT::VARCHAR, "CODI_EXPEDIENT"::VARCHAR, "Codi d'expedient"::VARCHAR, "Contracte núm."::VARCHAR, "Contracte_Num"::VARCHAR) AS id,
  'CATALUNYA' AS fuente,
  COALESCE(EXPEDIENT::VARCHAR, "CODI_EXPEDIENT"::VARCHAR, "Codi d'expedient"::VARCHAR, "Contracte núm."::VARCHAR, "Contracte_Num"::VARCHAR) AS expediente,
  COALESCE(
    NULLIF(ORGANISME, ''),
    NULLIF("NOM_ORGAN", ''),
    NULLIF("Òrgan de contractació", ''),
    NULLIF("NOM_DEPARTAMENT_ENS", ''),
    NULLIF("Organ_Contractant", ''),
    NULLIF("Òrgan contractant", ''),
    'Generalitat de Catalunya'
  ) AS organismo,
  COALESCE(
    NULLIF(OBJECTE, ''),
    NULLIF("OBJECTE_CONTRACTE", ''),
    NULLIF("Descripció del contracte", ''),
    NULLIF("Objecte contracte", ''),
    NULLIF("DENOMINACIO", ''),
    NULLIF("Contracte_Objecte", ''),
    'Sin título'
  ) AS objeto,
  COALESCE(
    NULLIF(TRIM(REPLACE(REPLACE(CODI_CPV::VARCHAR, '.0', ''), ' ', '')), ''),
    NULLIF(TRIM(REPLACE(REPLACE(SPLIT_PART(CODI_CPV, ',', 1), '.0', ''), ' ', '')), '')
  ) AS cpv,
  STRING_SPLIT(CODI_CPV::VARCHAR, ',') AS cpvs,
  COALESCE(
    IMP_NET_LICITACIO,
    TRY_CAST("PRESSUPOST_LICITACIO_SENSE_IVA" AS DOUBLE),
    TRY_CAST("PRESSUPOST_LICITACIO_SENSE_IVA_EXPEDIENT" AS DOUBLE),
    0
  ) AS importe_licitacion,
  COALESCE(
    IMP_NET_LICITACIO,
    TRY_CAST(PREU_CONTRACTE AS DOUBLE),
    TRY_CAST("IMPORT_ADJUDICACIO_SENSE_IVA" AS DOUBLE),
    TRY_CAST("Import adjudicat sense IVA" AS DOUBLE),
    TRY_CAST("Preu contracte (sense IVA)" AS DOUBLE),
    TRY_CAST("Preu_Contracte_Sense_IVA" AS DOUBLE),
    0
  ) AS importe_adjudicacion,
  COALESCE(
    TRY_STRPTIME(DATA_PUB_LICIT, '%d/%m/%y'),
    TRY_STRPTIME("DATA_PUBLICACIO_ANUNCI", '%Y-%m-%d'),
    TRY_STRPTIME("DATA_PUBLICACIO_ANUNCI", '%d/%m/%Y'),
    TRY_CAST("DATA_PUBLICACIO_ANUNCI" AS DATE)
  )::DATE AS fecha_publicacion,
  COALESCE(
    TRY_STRPTIME(DATA_PUB_ADJUDIC, '%d/%m/%y'),
    TRY_STRPTIME("DATA_PUBLICACIO_ADJUDICACIO", '%Y-%m-%d'),
    TRY_STRPTIME("DATA_PUBLICACIO_ADJUDICACIO", '%d/%m/%Y'),
    TRY_STRPTIME("DATA_PUBLICACIO_FORMALITZACIO", '%Y-%m-%d'),
    TRY_CAST("DATA_FORMALIT" AS DATE),
    TRY_CAST("DATA_PUBLICACIO_ADJUDICACIO" AS DATE),
    TRY_CAST("DATA_PUBLICACIO_FORMALITZACIO" AS DATE)
  )::DATE AS fecha_fin,
  COALESCE(URL, "ENLLAC_PUBLICACIO", NULLIF("URL_JSON_ADJUDICACIO", '')) AS url,
  COALESCE(
    NULLIF(ESTAT_DESC, ''),
    NULLIF("RESULTAT", ''),
    'Licitació'
  ) AS estado,
  COALESCE(
    NULLIF(ADJUDICATARI_RAO, ''),
    NULLIF("DENOMINACIO_ADJUDICATARI", ''),
    NULLIF("Nom adjudicatari", ''),
    NULLIF("Nom_Adjudicatari", ''),
    NULLIF("Empresa adjudicatària", ''),
    ADJUDICATARI_RAO
  ) AS adjudicatario,
  COALESCE(
    NULLIF(ADJUDICATARI_NIF, ''),
    NULLIF("IDENTIFICACIO_ADJUDICATARI", ''),
    NULLIF("NIF adjudicatari", ''),
    NULLIF("Nif_Adjudicatari", ''),
    ADJUDICATARI_NIF
  ) AS nif_adjudicatario
FROM catalunya
WHERE COALESCE(EXPEDIENT::VARCHAR, "CODI_EXPEDIENT"::VARCHAR, "Codi d'expedient"::VARCHAR, "Contracte núm."::VARCHAR, "Contracte_Num"::VARCHAR) IS NOT NULL

UNION ALL

-- galicia (1.7M)
SELECT
  id::VARCHAR AS id,
  'GALICIA' AS fuente,
  id::VARCHAR AS expediente,
  'Xunta de Galicia' AS organismo,
  objeto,
  NULL AS cpv,
  []::VARCHAR[] AS cpvs,
  CASE
    WHEN importe > 1000000000 THEN importe / 100000.0
    ELSE importe
  END AS importe_licitacion,
  0 AS importe_adjudicacion,
  publicado AS fecha_publicacion,
  NULL AS fecha_fin,
  NULL AS url,
  COALESCE(
    CASE estadoDesc
      WHEN 'En curso' THEN 'Publicada'
      WHEN 'Pendiente de adjudicar' THEN 'Publicada'
      WHEN 'Adjudicado provisional' THEN 'Adjudicada'
      WHEN 'Adjudicado' THEN 'Adjudicada'
      WHEN 'Desierto' THEN 'Desierta'
      WHEN 'Anulado/Desestimado' THEN 'Anulada'
      WHEN 'Formalizado' THEN 'Formalizada'
      WHEN 'Renuncia' THEN 'Resuelta'
      WHEN 'Suspensión por recurso' THEN 'Suspendida'
      WHEN 'Histórico' THEN 'Resuelta'
      ELSE estadoDesc
    END,
    'Publicada'
  ) AS estado,
  adjudicatario,
  nif AS nif_adjudicatario
FROM galicia
WHERE id IS NOT NULL

UNION ALL

-- comunidad_madrid (2.6M)
SELECT
  "Nº Expediente" AS id,
  'MADRID' AS fuente,
  "Nº Expediente" AS expediente,
  "Entidad Adjudicadora" AS organismo,
  "Título del contrato" AS objeto,
  NULL AS cpv,
  []::VARCHAR[] AS cpvs,
  CASE
    WHEN "Presupuesto de licitación" IS NOT NULL AND "Presupuesto de licitación" != 'nan'
    THEN
      CASE
        WHEN "Presupuesto de licitación" LIKE '%E%' OR "Presupuesto de licitación" LIKE '%e%'
        THEN TRY_CAST("Presupuesto de licitación" AS DOUBLE)
        ELSE TRY_CAST(REPLACE(REPLACE("Presupuesto de licitación", '.', ''), ',', '.') AS DOUBLE)
      END
    ELSE 0
  END AS importe_licitacion,
  CASE
    WHEN "Importe de adjudicación" IS NOT NULL AND "Importe de adjudicación" != 'nan'
    THEN
      CASE
        WHEN "Importe de adjudicación" LIKE '%E%' OR "Importe de adjudicación" LIKE '%e%'
        THEN TRY_CAST("Importe de adjudicación" AS DOUBLE)
        ELSE TRY_CAST(REPLACE(REPLACE("Importe de adjudicación", '.', ''), ',', '.') AS DOUBLE)
      END
    ELSE 0
  END AS importe_adjudicacion,
  CASE
    WHEN "Fecha del contrato" IS NOT NULL AND "Fecha del contrato" != 'nan'
      AND "Fecha del contrato" NOT LIKE '%de%'
    THEN TRY_CAST("Fecha del contrato" AS DATE)
    ELSE NULL
  END AS fecha_publicacion,
  NULL AS fecha_fin,
  NULL AS url,
  COALESCE(NULLIF("Estado", 'nan'), 'Pendiente de adjudicación') AS estado,
  "Adjudicatario" AS adjudicatario,
  "NIF del adjudicatario" AS nif_adjudicatario
FROM comunidad_madrid
WHERE "Nº Expediente" IS NOT NULL

UNION ALL

-- madrid_ayto ELIMINADO del view: 2.3M de 2.5M registros son duplicados de comunidad_madrid
-- Si se necesita en el futuro, descomentar el bloque siguiente y aplicar el mismo fix de notación científica

-- euskadi (713K)
-- Campos de objeto varían según origen:
--   B1_xlsx_sector_publico: título
--   B2_revascon_historico: título (puede ser null en registros antiguos)
--   A4_api_empresas: object, name (son empresas registradas, no contratos)
--   A3_api_poderes: object, nombre, descripción
--   C1_bilbao: título, objeto_del_contrato
--   v2 JSON anual: contratacion_titulo_contrato, contratacion_objeto_contrato, documentname
SELECT
  COALESCE(n_expediente, "código_de_contrato", id::VARCHAR, contratacion_expediente, expediente) AS id,
  'EUSKADI' AS fuente,
  COALESCE(n_expediente, "código_de_contrato", contratacion_expediente, expediente, id::VARCHAR) AS expediente,
  COALESCE(
    contratacion_poder_adjudicador_titulo,
    entidad_impulsora,
    poder_adjudicador,
    contratacion_entidad_impulsora,
    institución,
    institución,
    name,
    procedurecollection,
    'Gobierno Vasco'
  ) AS organismo,
  COALESCE(
    título,
    titulo_del_contrato,
    objeto_del_contrato,
    contratacion_titulo_contrato,
    contratacion_objeto_contrato,
    documentname,
    objeto,
    object,
    nombre,
    descripción,
    'Sin título'
  ) AS objeto,
  COALESCE(
    NULLIF(TRIM(REPLACE(REPLACE(cpv::VARCHAR, '.0', ''), ' ', '')), ''),
    NULLIF(TRIM(REPLACE(REPLACE(SPLIT_PART(cpv, ',', 1), '.0', ''), ' ', '')), ''),
        NULLIF(TRIM(contratacion_tipo_anuncio), ''),
    NULLIF(TRIM(tipo_de_contrato), ''),
    NULLIF(TRIM(tipo_contrato), '')
  ) AS cpv,
  STRING_SPLIT(cpv, ',') AS cpvs,
  CASE
    WHEN presupuesto_de_licitacion_iva_excluido IS NOT NULL AND presupuesto_de_licitacion_iva_excluido > 0
    THEN presupuesto_de_licitacion_iva_excluido
    ELSE 0
  END AS importe_licitacion,
  COALESCE(importe_de_adjudicación_con_iva, presupuesto_de_adjudicacion_iva_excluido, 0) AS importe_adjudicacion,
  COALESCE(
    TRY_CAST(fecha_de_publicación_documento AS DATE),
    TRY_CAST(publicationdate AS DATE),
    TRY_CAST(contratacion_fecha_de_publicacion_documento AS DATE),
    TRY_CAST(fecha_de_creación AS DATE)
  ) AS fecha_publicacion,
  COALESCE(
    TRY_CAST(fecha_límite_de_presentación AS DATE),
    TRY_CAST(contratacion_fecha_limite_presentacion AS DATE),
    TRY_CAST(fecha_de_adjudicacion AS DATE),
    TRY_CAST(fecha_de_formalizacion AS DATE)
  ) AS fecha_fin,
  COALESCE(url_amigable, url_física, physicalurl, mainentityofpage) AS url,
  COALESCE(
    CASE estado_de_contrato
      WHEN 'Ejecución' THEN 'En ejecución'
      WHEN 'Finalización' THEN 'Resuelta'
      ELSE estado_de_contrato
    END,
    NULLIF(TRIM(contratacion_estado_tramitacion), ''),
    'Publicada'
  ) AS estado,
  COALESCE(adjudicatario, contratacion_adjudicacion, contratista) AS adjudicatario,
  COALESCE(identificationnumber, registrationnumber) AS nif_adjudicatario
FROM euskadi
WHERE COALESCE(n_expediente, "código_de_contrato", id::VARCHAR, contratacion_expediente, expediente) IS NOT NULL

UNION ALL

-- asturias (375K)
SELECT
  "Nº INSCRIPCION" AS id,
  'ASTURIAS' AS fuente,
  COALESCE("Nº EXPEDIENTE ORGANO"::VARCHAR, "Nº INSCRIPCION") AS expediente,
  "ENTE CONTRATANTE" AS organismo,
  OBJETO AS objeto,
  CASE
    WHEN "CODIGO CPV" IS NOT NULL AND "CODIGO CPV" != ''
    THEN REGEXP_REPLACE("CODIGO CPV", '[^0-9]', '', 'g')
    ELSE NULL
  END AS cpv,
  CASE
    WHEN "CODIGO CPV" IS NOT NULL AND "CODIGO CPV" != ''
    THEN [REGEXP_REPLACE("CODIGO CPV", '[^0-9]', '', 'g')]
    ELSE []::VARCHAR[]
  END AS cpvs,
  CASE
    WHEN PRESUPUESTO IS NOT NULL AND PRESUPUESTO > 0 THEN PRESUPUESTO
    ELSE 0
  END AS importe_licitacion,
  0 AS importe_adjudicacion,
  TRY_STRPTIME("F. DE ALTA", '%d/%m/%Y')::DATE AS fecha_publicacion,
  NULL AS fecha_fin,
  NULL AS url,
  COALESCE("ESTADO CONTRATO", 'ACTIVO') AS estado,
  "CONTRATISTAS" AS adjudicatario,
  "NIF/CIF CONTRATISTA" AS nif_adjudicatario
FROM asturias
WHERE "Nº INSCRIPCION" IS NOT NULL

UNION ALL

-- valencia (246K)
SELECT
  EXPEDIENTE AS id,
  'VALENCIA' AS fuente,
  EXPEDIENTE AS expediente,
  COALESCE(CONSELLERIA_ENT_ADJUD, "UNIDAD   ") AS organismo,
  OBJETO AS objeto,
  COALESCE(
    NULLIF(TRIM(REPLACE(REPLACE(CODIGO_CPV::VARCHAR, '.0', ''), ' ', '')), ''),
    NULLIF(TRIM(REPLACE(REPLACE(SPLIT_PART(CODIGO_CPV, ',', 1), '.0', ''), ' ', '')), '')
  ) AS cpv,
  STRING_SPLIT(CODIGO_CPV, ',') AS cpvs,
  CASE
    WHEN IMPORTE_LICIT_SIN_IVA IS NOT NULL AND IMPORTE_LICIT_SIN_IVA != 'nan'
    THEN TRY_CAST(REPLACE(REPLACE(IMPORTE_LICIT_SIN_IVA, '.', ''), ',', '.') AS DOUBLE)
    ELSE 0
  END AS importe_licitacion,
  CASE
    WHEN IMP_ADJUD_SIN_IVA IS NOT NULL AND IMP_ADJUD_SIN_IVA != 'nan'
    THEN TRY_CAST(REPLACE(REPLACE(IMP_ADJUD_SIN_IVA, '.', ''), ',', '.') AS DOUBLE)
    ELSE 0
  END AS importe_adjudicacion,
  CASE
    WHEN FECHA_PUBL_LICIT_PERFIL IS NOT NULL AND FECHA_PUBL_LICIT_PERFIL != 'nan'
    THEN TRY_STRPTIME(FECHA_PUBL_LICIT_PERFIL, '%d/%m/%Y')::DATE
    WHEN FECHA_PUBL_LICIT_DOCV IS NOT NULL AND FECHA_PUBL_LICIT_DOCV != 'nan'
    THEN TRY_STRPTIME(FECHA_PUBL_LICIT_DOCV, '%d/%m/%Y')::DATE
    ELSE NULL
  END AS fecha_publicacion,
  CASE
    WHEN FECHA_FORMALIZACION IS NOT NULL AND FECHA_FORMALIZACION != 'nan'
    THEN TRY_CAST(FECHA_FORMALIZACION AS DATE)
    ELSE NULL
  END AS fecha_fin,
  CASE
    WHEN URL_LICITACION IS NOT NULL AND URL_LICITACION != 'No encontrada'
    THEN URL_LICITACION
    ELSE NULL
  END AS url,
  COALESCE(TIPO_DE_CONCLUSION, 'Publicada') AS estado,
  NOMBRE_O_RAZON_SOCIAL AS adjudicatario,
  CIF_NIF_ENMASCARADO AS nif_adjudicatario
FROM valencia
WHERE EXPEDIENTE IS NOT NULL

UNION ALL

-- boe (1.5K) — Boletín Oficial del Estado, sección V.A
SELECT
  id,
  'BOE' AS fuente,
  expediente,
  organismo,
  objeto,
  cpv,
  cpvs,
  importe_licitacion,
  importe_adjudicacion,
  fecha_publicacion,
  fecha_fin,
  url,
  estado,
  adjudicatario,
  nif_adjudicatario
FROM boe
WHERE id IS NOT NULL
;
