# Elicita Open Data — Market Intelligence v1

## Decisión solicitada

Aprobar este contrato como base de la primera publicación reproducible de **Tecnología y telecomunicaciones**. La aprobación autoriza implementar el pipeline, los artefactos públicos, `/datos-abiertos` y el bloque reutilizable de transparencia; no autoriza publicar cifras hasta superar todos los criterios de salida.

## Objetivo

Hacer que cada cifra de Market Intelligence pueda responder, con artefactos públicos y verificables:

1. qué universo se analizó;
2. qué registros se incluyeron y excluyeron;
3. cómo se resolvieron CPV, adjudicatarios, NIF, grupos y UTE;
4. qué cobertura tiene cada métrica;
5. qué pipeline y código produjeron el resultado;
6. qué limitaciones impiden una interpretación más fuerte.

## Alcance de v1

Incluye únicamente el piloto `technology`:

- contrato de snapshot versionado;
- metodología sectorial versionada;
- ranking agregado de sociedades y grupos;
- ranking de compradores;
- concentración y evolución anual;
- cobertura, exclusiones y categorías desconocidas;
- recibo de generación ligado a Git y a la fuente;
- JSON y CSV descargables;
- página `/datos-abiertos` y bloque de transparencia;
- base semántica común para web y futura consulta MCP.

Quedan fuera de v1:

- publicación del DuckDB o de volcados fila a fila;
- endpoint analítico arbitrario;
- actualización automática sin revisión editorial;
- atribución automática de grupos empresariales sin registro curado;
- comparación entre sectores;
- alertas y funcionalidades Pro;
- nuevos sectores.

## Fuente y ejecución

- Fuente analítica: vista `contratos_vivos` de la DuckDB materializada.
- Acceso del generador: solo lectura y preferentemente contra snapshot/copia coherente, no contra la base bloqueada por el proceso web.
- Salida: directorio temporal, validación completa y promoción atómica.
- La publicación web consume solo el último snapshot validado.
- Un fallo de generación conserva intacto el snapshot público anterior.

## Unidad y vocabulario

| Término | Definición v1 |
|---|---|
| Registro fuente | Fila observada en la vista analítica antes del filtrado sectorial. |
| Contrato analítico | Unidad deduplicada aceptada por la metodología; no equivale necesariamente a una fila, anuncio o lote fuente. |
| Sociedad | Adjudicatario identificado por un NIF normalizado. |
| Grupo | Conjunto curado y versionado de sociedades bajo control común. |
| UTE | Unión temporal; se mantiene separada salvo regla explícita y trazable de reparto. |
| Comprador | Órgano u organismo comprador bajo una clave normalizada y versionada. |
| Importe observado | Importe aceptado por la regla de selección; no implica gasto ejecutado. |
| Cuota por importe | Importe observado de la entidad dividido por el importe válido del universo publicado. |
| Cuota por contratos | Contratos analíticos de la entidad divididos por contratos con adjudicatario resoluble. |
| Unknown | Registro cuyo atributo no puede resolverse con evidencia suficiente; se publica como cobertura, no se imputa. |

## Taxonomía de Tecnología

La pertenencia al mercado se resolverá mediante una tabla versionada de reglas CPV, no mediante búsqueda textual libre. Cada regla tendrá:

- prefijo o código CPV;
- etiqueta y subsector;
- estado `include`, `exclude` o `review`;
- motivo;
- versión metodológica;
- fecha y fuente de la decisión.

Subsectores iniciales propuestos:

1. software y licencias;
2. servicios TI y desarrollo;
3. infraestructura, equipos y almacenamiento;
4. cloud, hosting y centros de datos;
5. redes y telecomunicaciones;
6. ciberseguridad;
7. soporte, mantenimiento y consultoría tecnológica.

Un registro sin CPV resoluble no entra mediante inferencia textual en v1. Se cuenta en cobertura y puede alimentar una cola de revisión futura.

## Reglas de identidad

### NIF

- Normalizar mayúsculas, separadores y espacios.
- Validar forma; una forma válida no prueba identidad jurídica.
- Mantener valores genéricos, múltiples o inválidos fuera del ranking nominal y dentro de `unknown`/exclusiones.
- No fusionar sociedades por similitud de nombre si falta evidencia estable.

### Grupos empresariales

Usar un registro curado con vigencia temporal:

```text
group_id, group_name, nif, company_name, valid_from, valid_to,
evidence_url, evidence_type, reviewed_at, registry_version
```

La agrupación por grupo es una vista derivada. El ranking por sociedad permanece disponible para evitar que una atribución corporativa opaque el dato original.

### UTE

- Publicar UTE como entidad propia cuando no exista reparto oficial verificable.
- No atribuir el 100 % a cada partícipe.
- Si existe desglose oficial, registrar regla, fuente y porcentajes.
- Mostrar la proporción de importe y contratos retenida en UTE sin resolver.

### Compradores

Mantener identificador canónico, nombre mostrado, alias y vigencia. No fusionar organismos por coincidencia textual sin revisión.

## Contrato público

Ruta canónica:

```text
/data/market-intelligence/technology/latest/
```

Artefactos:

```text
snapshot.json
companies.csv
business-groups.csv
buyers.csv
concentration.csv
evolution.csv
coverage.csv
exclusions.csv
methodology.json
generation-receipt.json
checksums.sha256
```

Los snapshots históricos se conservan bajo:

```text
/data/market-intelligence/technology/snapshots/{snapshot_id}/
```

`latest` se promueve solo después de validar y nunca se reconstruye en cliente.

## `snapshot.json`

```json
{
  "schema": "elicita.market-intelligence/v1",
  "snapshot_id": "technology-YYYYMMDD-HHMMSSZ",
  "dataset": "technology",
  "title": "Tecnología y telecomunicaciones",
  "generated_at": "ISO-8601 UTC",
  "period": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
  "source": {
    "name": "Elicita contratos_vivos",
    "freshness_date": "YYYY-MM-DD",
    "fingerprint": "sha256:..."
  },
  "methodology": {
    "schema_version": "1",
    "methodology_version": "1.0.0",
    "taxonomy_version": "1.0.0",
    "identity_registry_version": "1.0.0"
  },
  "universe": {
    "source_rows": 0,
    "sector_candidates": 0,
    "analytic_contracts": 0,
    "excluded_rows": 0
  },
  "coverage": {
    "cpv_resolved_pct": 0,
    "amount_valid_pct": 0,
    "supplier_nif_valid_pct": 0,
    "supplier_resolved_pct": 0,
    "business_group_resolved_pct": 0,
    "buyer_resolved_pct": 0,
    "ute_unresolved_amount_pct": 0
  },
  "metrics": {
    "observed_amount_eur": 0,
    "companies": 0,
    "business_groups": 0,
    "buyers": 0,
    "hhi_amount": 0,
    "hhi_contracts": 0
  },
  "downloads": {},
  "limitations": [],
  "license": {},
  "receipt": "generation-receipt.json"
}
```

Todos los porcentajes se almacenan como números entre 0 y 100. Los importes se almacenan en euros, sin abreviación visual. Fechas y claves conservan tipos estables. Los campos desconocidos no se omiten si forman parte del contrato: usan `null` con una razón documentada.

## CSV públicos

### `companies.csv`

```text
rank,nif,company_name,analytic_contracts,observed_amount_eur,
share_amount_pct,share_contracts_pct,group_id,group_name
```

### `business-groups.csv`

```text
rank,group_id,group_name,company_count,analytic_contracts,
observed_amount_eur,share_amount_pct,share_contracts_pct
```

### `buyers.csv`

```text
rank,buyer_id,buyer_name,analytic_contracts,observed_amount_eur,
share_market_amount_pct
```

### `concentration.csv`

```text
period,dimension,hhi,top1_share_pct,top5_share_pct,top10_share_pct,
valid_denominator
```

### `evolution.csv`

```text
year,entity_type,entity_id,entity_name,analytic_contracts,
observed_amount_eur,share_amount_pct,share_contracts_pct
```

### `coverage.csv`

```text
metric,numerator,denominator,coverage_pct,unknown_count,definition
```

### `exclusions.csv`

Solo agregados, nunca filas identificables por defecto:

```text
reason_code,reason_label,rows,amount_eur,share_source_rows_pct
```

## Recibo de generación

`generation-receipt.json` prueba qué produjo el snapshot, sin autorizar su publicación por sí solo:

```json
{
  "schema": "elicita.generation-receipt/v1",
  "snapshot_id": "technology-YYYYMMDD-HHMMSSZ",
  "generated_at": "ISO-8601 UTC",
  "pipeline_commit": "full git sha",
  "working_tree_clean": true,
  "source_fingerprint": "sha256:...",
  "taxonomy_hash": "sha256:...",
  "identity_registry_hash": "sha256:...",
  "query_hash": "sha256:...",
  "outputs": { "snapshot.json": "sha256:..." },
  "checks": {
    "schema_valid": true,
    "duplicate_analytic_ids": 0,
    "shares_within_tolerance": true,
    "rankings_deterministic": true,
    "no_direct_identifiers": true,
    "minimum_group_policy_applied": true,
    "freshness_non_regression": true
  }
}
```

El recibo se deriva de Git, la fuente y los bytes generados; no de un resumen narrativo del agente.

## Privacidad y publicación responsable

Aunque las adjudicaciones son información pública, la capa Open Data aplicará minimización:

- publicar agregados empresariales y de organismos, no perfiles personales;
- no publicar emails, teléfonos, usuarios, búsquedas, alertas ni actividad de clientes;
- no incluir rutas internas, hostnames, credenciales o identificadores operativos;
- retener categorías pequeñas cuando su publicación pueda singularizar una observación no necesaria;
- declarar el umbral aplicado en el snapshot;
- validar que ningún artefacto contenga campos no permitidos.

Para rankings empresariales públicos no se anonimiza una sociedad por ser un grupo pequeño: la entidad adjudicataria es el objeto del análisis y procede de contratación pública. Sí se aplica supresión a desgloses secundarios que puedan reconstruir una fila singular sin valor analítico suficiente.

## Licencias y atribución

- Código, schemas y pipeline: licencia del repositorio.
- Agregados originales producidos por Elicita: propuesta `CC BY 4.0`.
- Fuentes administrativas: conservan sus condiciones y atribución propias.
- La página debe aclarar que Elicita transforma y agrega datos de terceros; no adquiere derechos sobre los registros fuente.
- La adopción de `CC BY 4.0` requiere revisión antes de publicar el primer snapshot.

## Superficie web

### `/datos-abiertos`

Debe mostrar:

- catálogo de datasets;
- snapshot vigente y fecha de frescura;
- periodo, universo y cobertura;
- archivos y checksums;
- versión metodológica y changelog;
- licencia y atribución;
- limitaciones y “qué no sabemos”;
- enlace a snapshots históricos.

El HTML incorpora durante el build el último snapshot válido. JavaScript puede refrescar datos, pero su fallo no elimina las cifras ni las descargas renderizadas.

### Bloque `DataTransparency`

Componente reutilizable para artículos y páginas vivas:

- actualizado;
- periodo;
- contratos analíticos;
- cuatro coberturas esenciales;
- metodología;
- limitaciones;
- descarga JSON/CSV;
- identificador del snapshot.

No debe reducirse a un badge de “datos verificados”. La evidencia esencial debe ser visible sin interacción.

## Semántica web, API y MCP

La misma definición debe gobernar las tres superficies:

| Concepto | Nombre canónico |
|---|---|
| Dataset | `technology` |
| Cuota por importe | `share_amount_pct` |
| Cuota por contratos | `share_contracts_pct` |
| Contratos analíticos | `analytic_contracts` |
| Importe observado | `observed_amount_eur` |
| Concentración | `hhi` |
| Cobertura | `coverage_pct` |

La futura herramienta MCP no recalcula con reglas diferentes: lee el snapshot publicado o ejecuta el mismo módulo analítico versionado.

## Versionado

- `schema_version`: cambia solo ante ruptura de contrato.
- `methodology_version`: SemVer; major cambia comparabilidad, minor añade reglas compatibles, patch corrige documentación o implementación sin alterar intención.
- `taxonomy_version`: versiona inclusión CPV y subsectores.
- `identity_registry_version`: versiona sociedades, grupos, UTE y compradores.
- Cada snapshot conserva todas sus versiones y hashes.
- Un cambio que altere rankings históricos genera snapshot nuevo y entrada de changelog; nunca reescribe silenciosamente el anterior.

## Controles obligatorios

### Integridad

- schema JSON válido;
- columnas CSV exactas y orden estable;
- hashes coincidentes;
- codificación UTF-8 y finales de línea consistentes;
- orden determinista con desempate explícito.

### Universo

- fechas dentro del periodo declarado;
- CPV incluido por regla versionada;
- deduplicación documentada;
- cero IDs analíticos duplicados;
- exclusiones reconciliadas con candidatos.

### Métricas

- importes finitos, no negativos y en euros;
- denominadores explícitos;
- cuotas entre 0 y 100;
- suma de cuotas compatible con `unknown` y tolerancia declarada;
- HHI calculado desde cuotas no redondeadas;
- ranking por importe y ranking por contratos independientes.

### Identidad

- todo NIF nominal supera validación formal y resolución curada;
- ninguna sociedad se fusiona solo por nombre;
- toda pertenencia a grupo tiene evidencia y vigencia;
- UTE sin reparto permanece separada;
- unknowns conservados y cuantificados.

### Seguridad y privacidad

- allowlist de campos públicos;
- ausencia de secretos y rutas internas;
- ausencia de información de usuarios;
- supresión secundaria aplicada donde proceda;
- artefactos servidos como descargas, no ejecutables.

### Reproducibilidad

- commit completo registrado;
- árbol limpio o excepción explícita que bloquea publicación;
- fingerprint de fuente;
- hashes de reglas y consultas;
- segunda ejecución contra la misma entrada produce los mismos hashes.

## Gate editorial

El pipeline puede producir un candidato, pero no publicarlo. La promoción requiere revisión humana de:

1. definición del mercado y exclusiones CPV;
2. veinte primeras sociedades y grupos;
3. UTE con mayor peso;
4. compradores principales;
5. cambios frente al snapshot anterior;
6. limitaciones y lenguaje del artículo;
7. licencia y atribución.

No se publica si una cifra principal contradice el artículo existente sin explicación y actualización coordinada.

## Criterios de salida de v1

La entrega se considera lista solo cuando:

- el generador trabaja contra una copia coherente y reproducible;
- todos los artefactos cumplen schemas y checksums;
- dos ejecuciones idénticas producen hashes idénticos;
- no hay duplicados analíticos;
- la taxonomía CPV y el registro de identidad están versionados;
- cobertura y unknowns aparecen en JSON, CSV y HTML;
- `/datos-abiertos` funciona sin JavaScript;
- el fallo de actualización conserva el snapshot anterior;
- existe smoke test de cada descarga;
- el artículo de IT referencia exactamente el snapshot aprobado;
- un revisor humano aprueba top entidades, cambios y limitaciones;
- build y pruebas aplicables terminan correctamente.

## Secuencia de implementación propuesta

1. Congelar schema, taxonomía y reglas de identidad v1.
2. Extraer una copia coherente de la base materializada.
3. Implementar generador determinista en modo candidato.
4. Añadir validadores, fixtures y pruebas de reproducibilidad.
5. Revisar manualmente resultados de Tecnología.
6. Implementar publicación atómica e históricos.
7. Crear `/datos-abiertos` y `DataTransparency` con fallback estático.
8. Actualizar el artículo de IT con el snapshot aprobado.
9. Añadir lectura MCP como entrega posterior, sin duplicar lógica.

## Decisiones pendientes antes de implementar

1. Confirmar licencia de los agregados: `CC BY 4.0` recomendada.
2. Confirmar periodo inicial: se recomienda **2022–última fecha completa** para comparabilidad reciente.
3. Aprobar taxonomía CPV exacta tras inspección de volumen y falsos positivos.
4. Definir quién firma la revisión editorial del primer snapshot.
5. Decidir política de conservación: se recomienda mantener todos los snapshots publicados y permitir retirar solo archivos legalmente problemáticos mediante changelog explícito.
