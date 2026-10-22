# Elicita API — Referencia

> **Estado:** Funcional. Endpoints v1 con API keys operativos.
> **Base URL:** `https://elicita.es/api`

---

## Autenticación

### API Keys (Bearer)

Todos los endpoints bajo `/api/v1/` aceptan API keys vía header:

```
Authorization: Bearer elc_tu_api_key
```

Las API keys se gestionan desde el dashboard de Elicita (sesión Clerk requerida para crearlas, vía `/api/v1/keys`).

**Planes con acceso API:** Pro y Trial.

### Sesión Clerk (web)

Los endpoints web (`/api/data`, `/api/stats`, `/api/cpv`, `/api/alertas`) usan sesión Clerk. `/api/alertas` ahora acepta ambos: Bearer API key o sesión Clerk.

---

## Endpoints v1

### `GET /api/v1/search`

Búsqueda full-text sobre 30.9M+ licitaciones con filtros avanzados.

**Headers:** `Authorization: Bearer elc_xxx`

**Parámetros:**

| Parámetro | Tipo | Default | Descripción |
|-----------|------|---------|-------------|
| `q` | string | — | Búsqueda libre (objeto/organismo) |
| `cpv` | string | — | Código CPV (prefix match, ej. `72` = servicios TI) |
| `nif` | string | — | NIF del adjudicatario |
| `estado` | string | — | Estado del contrato (Adjudicada, Publique, ...) |
| `fuente` | string | — | Fuente (PLACE, TED, Andalucía, Catalunya, Euskadi, Galicia, Valencia, Aragón, Madrid CM, Madrid Ayto, Asturias) |
| `desde` | string | — | Año desde (YYYY) |
| `hasta` | string | — | Año hasta (YYYY) |
| `min` | number | — | Importe mínimo (€) |
| `max` | number | — | Importe máximo (€) |
| `limit` | number | 20 | Resultados por página (max 100) |
| `offset` | number | 0 | Paginación |
| `sort` | string | fecha | Campo: titulo, organismo, importe, fecha, fuente |
| `dir` | string | desc | Dirección: asc, desc |

**Respuesta:**

```json
{
  "ok": true,
  "results": [
    {
      "titulo": "SERVICIO DE MANTENIMIENTO HVAC",
      "organismo": "Ayuntamiento de Sevilla",
      "importe": 45000.0,
      "fecha": "2024-03-15",
      "fuente": "PLACE",
      "cpv": "72000000",
      "estado": "Adjudicada",
      "url_pub": "https://..."
    }
  ],
  "meta": {
    "total": 1523,
    "limit": 20,
    "offset": 0,
    "took_ms": 42
  }
}
```

---

### `GET /api/v1/org/<nif>`

Ficha de empresa por NIF. Incluye contratos adjudicados y enriquecimiento BORME.

**Headers:** `Authorization: Bearer elc_xxx`

**Path param:** NIF del adjudicatario (ej. `B15044357`)

**Respuesta:**

```json
{
  "ok": true,
  "nif": "B15044357",
  "nombre": "APPLUS NORCONTROL SL",
  "total_contratos": 42,
  "volumen_total": 1234567.89,
  "contratos": [
    {
      "titulo": "...",
      "organismo": "...",
      "importe": 12345.67,
      "fecha": "2024-01-15",
      "fuente": "PLACE",
      "cpv": "72000000",
      "estado": "Adjudicada",
      "url_pub": "https://..."
    }
  ],
  "borme": {
    "domicilio": "...",
    "capital_euros": 50000,
    "fecha_constitucion": "1995-06-12",
    "provincia": "Sevilla",
    "fecha_borme": "1995-06-20"
  },
  "meta": {
    "took_ms": 35
  }
}
```

**Errores:**
- `404` — NIF no encontrado: `{ "ok": false, "error": "NIF no encontrado" }`
- `401` — No autenticado
- `403` — Plan insuficiente (requiere Pro/Trial)

---

### `GET /api/v1/keys`

Gestión de API keys. **Requiere sesión Clerk** (no Bearer).

- `GET` — Lista keys del usuario
- `POST` — Crea nueva key

**Respuesta (GET):**

```json
{
  "keys": [
    {
      "id": "key_xxx",
      "prefix": "elc_abc...",
      "created_at": "2026-06-01T00:00:00Z",
      "last_used": "2026-06-27T10:00:00Z",
      "revoked": false
    }
  ]
}
```

---

### `GET /api/graph`

Grafo de relaciones entre organismos y adjudicatarios. **Sin auth.**

**Parámetros:**

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `q` | string | Nodo raíz (nombre) |
| `type` | string | Tipo de nodo: `organismo`, `adjudicatario` |
| `cpv` | string | Filtrar por CPV |
| `year` | string | Filtrar por año |

---

### `GET /api/alertas` | `POST /api/alertas`

Gestión de alertas de búsqueda. **Acepta Bearer API key o sesión Clerk.**

**GET** — Lista alertas del usuario.

**POST** — Crea alerta:
```json
{
  "query": "mantenimiento HVAC",
  "cpv": ["72", "48"]
}
```

**Plan enforcement:**
- Free: 1 alerta
- Pro: alertas ilimitadas + alertas de competidores

---

## Endpoints públicos (sin autenticación)

Consultables sin API key ni sesión. Token-bucket por IP (`CF-Connecting-IP`),
ventana fija en memoria, implementado en `web/src/lib/rate-limit.ts`. Las
respuestas agregadas llevan memo de origen (`lib/cache`, tareas 32/29) además
de los headers `Cache-Control`/`s-maxage` para el edge.

### `GET /api/v1/sector/<cpv>`

Análisis competitivo del sector por código CPV. Sin auth (rate limit propio de
la familia pública). El CPV se normaliza a prefijo ("33140000" → "3314") y
captura toda la familia del código. Memo TTL 300s por (cpv, año); fechas
anteriores a 1990 quedan fuera del análisis y se cuentan en
`contratos_excluidos_por_fecha`.

**Parámetros:**

| Parámetro | Dónde | Requerido | Descripción |
|-----------|-------|-----------|-------------|
| `cpv` | path | sí | Código CPV (8 dígitos; acepta "3314.00.00" o "33140000.0") |
| `año` | query | no | Filtra por `EXTRACT(YEAR FROM fecha_publicacion)` |

**Rate limit:** 120 req/min por IP. **Memo:** 300s.

**Ejemplo real (extracto de `GET /api/v1/sector/3314`, preview 20-10-2026):**

```json
{
  "ok": true,
  "cpv": "3314",
  "resumen": {
    "total_contratos": 154003,
    "contratos_excluidos_por_fecha": 83,
    "volumen_total_eur": 237843075831,
    "volumen_total_formateado": "237.843.075.831",
    "contrato_medio_eur": 1544405,
    "proveedores_unicos": 7495,
    "organismos_unicos": 4103,
    "primer_contrato": "2011-03-16",
    "ultimo_contrato": "2026-01-26"
  },
  "top_proveedores": [
    {
      "nif": "B83397802",
      "nombre": "Acciona Concesiones,S.L.",
      "contratos": 3,
      "volumen_eur": 867532243.17,
      "pct_volumen": 0.0036,
      "pct_contratos": 0
    }
    // … hasta 20
  ],
  "top_organismos": [
    { "organismo": "Servicio Andaluz de Salud", "contratos": 7562, "volumen_eur": 49400551917.130135 }
    // … hasta 15
  ],
  "distribucion_temporal": { "2011": 6, "2026": 606 },
  "distribucion_geografica": [
    { "nuts": "ES24", "region": "Aragón", "contratos": 1068, "volumen_eur": 31424789917.979977 }
    // … hasta 15 (NUTS → CCAA mapeado en el endpoint)
  ],
  "concentracion": {
    "hhi": 0.0076,
    "top_3_pct_volumen": 0.0093,
    "top_5_pct_volumen": 0.0143,
    "top_10_pct_volumen": 0.0238
  },
  "tendencia": "creciente",
  "meta": { "took_ms": 8915, "filtro_anno": null }
}
```

**Errores reales:**
- `400` — formato de CPV inválido: `{ "ok": false, "error": "Código CPV inválido. Formato esperado: 8 dígitos (ej. 33140000)." }`
- `404` — CPV válido sin contratos: `{ "ok": false, "error": "No se encontraron contratos válidos para el CPV 99999999.", "cpv": "99999999" }`

### `GET /api/public/search`

Búsqueda pública anónima (la que usa `/buscar`). Token-bucket por IP.

**Rate limit:** 3 búsquedas/día por IP (ventana 24h). Cabeceras
`X-RateLimit-Limit` / `X-RateLimit-Remaining` en cada respuesta.

**Parámetros:**

| Parámetro | Default | Descripción |
|-----------|---------|-------------|
| `q` | — | Búsqueda libre; con `smart=1` usa el asistente IA |
| `cpv` | — | Código CPV |
| `importeMin` / `importeMax` | — | Importe mínimo/máximo (€) |
| `estado` | — | Estado del contrato |
| `fuente` | — | Fuente (ver tabla de fuentes) |
| `nif` | — | NIF del adjudicatario |
| `desde` / `hasta` | — | Año desde/hasta (YYYY) |
| `limit` | 10 | Resultados por página (anónimo: máx. 20) |
| `offset` | 0 | Paginación |
| `sort` / `dir` | — / desc | Orden: titulo, organismo, importe, fecha, fuente |

Requiere `q` o algún filtro distinto de `limit`/`offset` (si no, `400`).

**Ejemplo real (extracto de `GET /api/public/search?q=iberdrola&limit=5`):**

```json
{
  "ok": true,
  "anonymous": true,
  "cta": "Regístrate para más búsquedas",
  "smart": false,
  "query": { "q": "iberdrola", "filters": {} },
  "results": [
    {
      "id": "AND:598946",
      "fuente": "ANDALUCIA",
      "expediente": "1055_2023",
      "organismo": "Fundación Pública Andaluza Progreso y Salud ",
      "titulo": "CONTRATO BASADO EN EL ACUERDO MARCO DE SUMINISTRO DE ENERGÍA ELÉCTRICA…",
      "cpv": "09310000",
      "importe": 703500,
      "importe_adjudicacion": 703500,
      "fecha": "2026-09-25",
      "estado": "resuelta",
      "adjudicatario": "IBERDROLA SAU;",
      "nif_adj": "A95758389",
      "_score": 1,
      "ai_resumen": null
    }
  ],
  "pagination": { "limit": 5, "offset": 0, "has_more": true },
  "meta": { "took_ms": 2075, "rate_limit_remaining": 1 }
}
```

**Errores reales:**
- `400` — sin `q` ni filtros: `{ "error": "Introduce un término de búsqueda o filtro" }`
- `429` — límite diario: `{ "error": "Has alcanzado el límite de búsquedas diarias como usuario anónimo.", "code": "daily_limit_exceeded", "remaining": 0, "limit": 3, "anonymous": true, "cta": "Regístrate para más búsquedas", "upgrade_url": "/sign-up" }`

### `GET /api/public/ticker`

Las licitaciones adjudicadas más recientes con importe > 100.000 € (20 filas,
orden por fecha de publicación DESC). Memo 60s; `Cache-Control: public,
max-age=600, s-maxage=600`.

**Rate limit:** 60 req/min por IP. **Sin parámetros.**

**Ejemplo real (extracto):**

```json
{
  "data": [
    {
      "expediente": "8151-2025",
      "organo": "Dirección de Compras de la Corporación de Radio y Televisión Española S.A.",
      "adjudicatario": "ENDESA ENERGIA",
      "importe": 18120073.66,
      "fecha_publicacion": "2026-01-26"
    }
    // … 20 filas
  ],
  "last_updated": "2026-10-20T05:30:40.822Z"
}
```

`503` con `{ "data": [], "last_updated": null, "error": "ticker unavailable" }` si la BD no está disponible.

### `GET /api/cobertura`

Registro vivo del dataset: las 16 fuentes con registros, recuento total y
marcas de tiempo de la última lectura. Memo 60s.

**Rate limit:** 120 req/min por IP. **Sin parámetros.**

**Ejemplo real (extracto):**

```json
{
  "fuentes": [
    {
      "key": "nacional",
      "name": "PLACSP Nacional",
      "description": "Plataforma de Contratación del Sector Público…",
      "region": "España",
      "records": 13419448,
      "firstData": "2002",
      "lastData": "2026",
      "format": "ATOM/XML",
      "frequency": "Cada 4h",
      "lastUpdate": "2026-10-20T05:37:17.873Z"
    }
    // … 16 fuentes: nacional, ted, catalunya, comunidad_madrid, madrid_ayto,
    // galicia, andalucia, euskadi, asturias, valencia, dogv, doga, boe,
    // calidad, borme_empresas, borme_cargos
  ],
  "totalRecords": 63346979,
  "globalLastRun": "2026-10-20T05:30:14.315Z",
  "generatedAt": "2026-10-20T05:43:56.897Z"
}
```

### `GET /api/health`

Salud del pipeline de ingesta: estado de conectores y frescura de la caché.

**Rate limit:** sin límite. **Cacheable:** no.

**Parámetros:**

| Parámetro | Default | Descripción |
|-----------|---------|-------------|
| `mode` | `summary` | `summary` (agregado) o `detailed` (estado por conector) |

**Ejemplo real (`mode=summary`):**

```json
{
  "status": "healthy",
  "connectors": { "total": 1, "healthy": 1, "degraded": 0, "failed": 0 },
  "cache": { "status": "fresh", "age_minutes": 13, "size_mb": "0.49", "contratos": 89291 },
  "last_cycle": "2026-10-20T05:30:14.315Z",
  "cycle_duration_ms": 613545,
  "timestamp": "2026-10-20T05:43:56.742Z"
}
```

### `GET /api/graph-public`

Grafo de relaciones organismo↔adjudicatario alrededor de un nodo raíz. Memo 300s.

**Rate limit:** 60 req/min por IP.

**Parámetros:**

| Parámetro | Descripción |
|-----------|-------------|
| `q` | Nodo raíz (nombre de empresa u organismo) |
| `type` | `adjudicatario` o `organismo` |

**Ejemplo real (extracto de `?q=indra&type=adjudicatario`):**

```json
{
  "center": { "id": "A28599033", "name": "INDRA", "type": "adjudicatario" },
  "nodes": [
    { "id": "A28599033", "name": "INDRA", "type": "adjudicatario", "contratos": 8, "volumen": 2988707.421 },
    { "id": "org:Agencia de Obra Pública de la Junta de Andalucía (AOPJA) ", "name": "Agencia de Obra Pública de la Junta de Andalucía (AOPJA) ", "type": "organismo", "contratos": 1, "volumen": 2897797 }
    // …
  ],
  "edges": [
    { "source": "A28599033", "target": "org:Agencia de Obra Pública de la Junta de Andalucía (AOPJA) ", "contratos": 1, "volumen": 2897797 }
    // …
  ]
}
```

**Errores reales:** `404` — `{ "error": "Empresa no encontrada" }`.

### `GET /api/graph-public/featured`

Nodo destacado del grafo. Sin `cpv`: rotación aleatoria (sin memo, para variar
la portada). Con `cpv`: organismo líder de ese sector, determinista y memo 300s.

**Rate limit:** 60 req/min por IP.

**Parámetros:**

| Parámetro | Descripción |
|-----------|-------------|
| `cpv` | (opcional) Código CPV — modo sector determinista |

**Ejemplo real (`?cpv=33`):**

```json
{
  "type": "organismo",
  "id": "Servicio Andaluz de Salud ",
  "nombre": "Servicio Andaluz de Salud ",
  "contratos": 13753,
  "volumen": 924930507.2999997
}
```

### `GET /api/graph-search-public`

Autocompletado del grafo: resuelve un nombre a nodos candidatos.
Memo 300s. **Rate limit:** 60 req/min por IP.

**Parámetros:** `q` (nombre a resolver).

**Ejemplo real (`?q=medtronic`):**

```json
[{ "name": "MEDTRONIC IBERICA, S.A.U.", "id": "A28389484", "type": "adjudicatario" }]
```

### Rutas fuera de esta referencia

El resto de rutas bajo `/api/` son superficie de producto u operación interna,
no pensadas para clientes API de terceros, y no se documentan aquí:

- **Producto autenticado (Clerk/Bearer):** `/api/v1/alerts`, `/api/ai/*`,
  `/api/stripe/*`, `/api/follows`, `/api/saved-searches`, `/api/onboard`,
  `/api/profile`, `/api/user-plan`, `/api/waitlist`, `/api/contact`,
  `/api/feedback`, `/api/organismos`, `/api/graph-search`,
  `/api/graph-contracts`, `/api/radar/*`, `/api/borme-info`, `/api/calidad`,
  `/api/conflictos`, `/api/search`.
- **Internas del sistema:** `/api/admin/*`, `/api/clerk/*`, `/api/test/*`,
  `/api/demo/*`, `/api/reload`, `/api/v1/alerts-internal`.

---

## Exportación CSV (producto web)

### `GET /api/export`

Exporta resultados de búsqueda como CSV. **Requiere sesión Clerk con plan Pro
o superior** (no acepta API key). Sin rate limit HTTP propio; el plan manda.

**Parámetros:** mismos que `/api/search` (`q`, `fuente`, `cpv`, `date_from`,
`date_to`, …). Límite: 200 filas por export.

**Columnas CSV:** Fuente, Expediente, Organismo, Objeto, CPV, Importe
Licitación, Importe Adjudicación, Fecha Publicación, Fecha Fin, Estado,
Adjudicatario, NIF Adjudicatario, URL.

**Errores reales:**
- `401` sin sesión: `{ "error": "No autenticado" }`
- `403` sin plan Pro: `{ "error": "Export CSV requiere plan Pro", "upgrade": "/precios" }`

---

## Endpoints web (legacy)

### `GET /api/data`

Endpoint original del dashboard web. Usa sesión Clerk. Devuelve contratos con formato legacy (campos en español, importes como string). Soportado pero no recomendado para nuevas integraciones — usar `/api/v1/search` en su lugar.

### `GET /api/stats`

Estadísticas agregadas del dataset (66.4M registros). Cache: 5 minutos.

### `GET /api/cpv`

Diccionario CPV completo (9,454 códigos en español).

---

## Fuentes de datos

| Código | Fuente | Cobertura |
|--------|--------|-----------|
| PLACSP | Plataforma de Contratación del Estado | Nacional |
| TED | TED (Europa) | Licitaciones europeas |
| Andalucía | Junta de Andalucía | CCAA |
| Catalunya | Generalitat de Catalunya | CCAA |
| Euskadi | Gobierno Vasco | CCAA |
| Galicia | Xunta de Galicia | CCAA |
| Valencia | Generalitat Valenciana | CCAA |
| Aragón | Gobierno de Aragón | CCAA |
| Madrid CM | Comunidad de Madrid | CCAA |
| Madrid Ayto | Ayuntamiento de Madrid | Local |
| Asturias | Principado de Asturias | CCAA |
| BORME | Boletín Registral Mercantil | Empresas + cargos (2009-2026) |

---

## Rate limits

| Plan | Límite mensual | Rate limit |
|------|---------------|------------|
| Free | 3 búsquedas/día (web, sin API) | — |
| Pro | 1.000 queries/mes | 100 req/min (token bucket) |
| Trial | 1.000 queries/mes (14 días) | 100 req/min |

### Endpoints públicos sin auth

Token-bucket compartido por IP (`CF-Connecting-IP`), ventana fija en memoria, implementado en `web/src/lib/rate-limit.ts`:

| Endpoint | Límite |
|----------|--------|
| `GET /api/public/search` | 3/día por IP |
| `GET /api/public/ticker` | 60/min por IP |
| `GET /api/graph-public` | 60/min por IP |
| `GET /api/graph-search-public` | 60/min por IP |
| `GET /api/graph-public/featured` | 60/min por IP |
| `GET /api/cobertura` | 120/min por IP |
| `GET /api/stats` | 120/min por IP |
| `GET /api/cpv` | 120/min por IP |
| `GET /api/v1/sector/<cpv>` | 120/min por IP |
| `GET /api/health` | — (sin límite) |

HTTP 429 con `Retry-After` y cabeceras `X-RateLimit-*` cuando se excede. Las respuestas JSON cacheables llevan `s-maxage` para el edge de Cloudflare (que exige una Cache Rule en el dashboard para cachear JSON — acción del operador).

---

## CLI y MCP

- **CLI:** `elicitac` — ver [docs/CLI.md](./CLI.md)
- **MCP Server:** `elicitac-mcp` — ver [docs/MCP.md](./MCP.md)
- **npm:** `npm install -g @elcanosail/elicitac`
- **Plan requerido:** Pro (€79/mes) o Trial (14 días gratuito)

---

*Última actualización: 20 Oct 2026* — superficie pública reconciliada con el código (tarea 49; ejemplos capturados de preview).