# Elicita MCP — contrato v1 reducido

Interfaz canónica: TypeScript, Streamable HTTP stateless, `https://elicita.es/mcp`. Código en `mcp-server/`. Go/stdio en `cli/mcp/` permanece **legacy**, no define este contrato.

## Autenticación y ruptura temporal de OAuth

- Sin Authorization: búsqueda pública, `/api/public/search`.
- API key directa con formato `elicita_live_<32hex>_<48hex>` enviada por Bearer: búsqueda vía `/api/v1/search`. Formato reconocido significa **credencial presente**, no identidad verificada. Backend valida key, revocación, plan y cuota.
- Bearer mal formado/desconocido, incluidos antiguos tokens OAuth: HTTP 401. No hay fallback anónimo.
- **OAuth y discovery desactivados incondicionalmente**, para todos los métodos: `/authorize`, `/token`, `/register`, `/mcp/callback`, rutas `.well-known`. Devuelven 404; el módulo OAuth heredado no se importa en runtime. Los clientes OAuth anteriores deberán usar API key directa o modo público. Reintroducción requiere otro incremento auditado.

## Tools

Tools estables: `search_licitaciones`, `get_stats`, `get_cobertura`, `search_cpv`, `market_snapshot`, `rank_companies`, `analyze_buyer` y `trace_metric`. Las cuatro tools de Market Intelligence son públicas, de solo lectura y sirven exclusivamente el snapshot editorial aprobado; no ejecutan SQL ni consultan la base viva.

`get_organismo`, `graph_search`, `graph_contracts` y `analyze_pliego` no se registran ni ejecutan, incluso con flag experimental y key bien formada. `ask_elicita` fue retirado del paquete: dependía del binding clásico de DuckDB, no estaba registrado y duplicaba el patrón descartado de chat SQL genérico. Ninguna de estas capacidades es habilitable por entorno.

## Búsqueda

| MCP | API |
|---|---|
| q, cpv, estado, fuente, nif | mismo nombre |
| importe_min / importe_max | importeMin / importeMax |
| fecha_desde / fecha_hasta | desde / hasta (años 2000–2099) |
| limit / offset | mismo nombre (default 20 / 0) |
| dir | asc / desc |

**Sort — contrato candidato, NO desplegado.** El backend corrige la whitelist para resolver a las columnas proyectadas de la consulta `UNION` (`titulo`, `organismo`, `adjudicatario`, `importe`, `fuente`, `fecha`), y añade desempate estable (`fuente ASC, id ASC`). El MCP valida con una allowlist canónica:

- `sort` ausente o vacío → no se envía; el backend conserva su default (`fecha`).
- `sort` en la allowlist (`titulo|organismo|adjudicatario|importe|fuente|fecha`) → se envía tal cual, junto a `dir` (`asc`/`desc`).
- `sort` con sintaxis legacy `campo:dir` → **error explícito** (`Sintaxis de ordenación legacy no soportada. Usa sort=<campo> y dir=asc|desc separados.`).
- `sort` desconocido / fuera de allowlist → **error explícito** (`Campo de ordenación no soportado: ...`), sin fallback silencioso.

No se amplían alias incompatibles sin cambio de contrato. **Este comportamiento es el descrito para un candidato; la producción sigue con `sort` desactivado** hasta que el cambio se despliegue y verifique. Sin `sort`, el backend usa el alias exterior `fecha`, válido según el SQL del repositorio; no se ha consultado producción.

Respuesta: resumen compacto + JSON `results/pagination/meta` en texto y `structuredContent`. Total ausente = desconocido; respuesta upstream malformada = error, nunca búsqueda vacía exitosa. Errores backend 401/429 se devuelven como `isError=true`, sin contenido sensible ni reintento público.

## Estadísticas y frescura

`get_stats` usa `totalHistorical` como registros históricos, **no contratos únicos**, y `lastUpdate` como actualización del pipeline. No suma BORME, histórico y tiempo real. `generatedAt` es generación de respuesta, nunca frescura.

`get_cobertura` muestra `globalLastRun` como ejecución global del pipeline y `lastUpdate` de cada fuente por separado; null/vacío = desconocido. Ni el total agregado de registros ni una ejecución global acreditan contratos únicos o actualización de todas las fuentes.

## Transporte, límites y confianza

- El MCP no cobra cuota por initialize/tools/list. La API pública aplica 3 búsquedas/día por IP; autenticada según backend/plan.
- IP: solo se usa X-Real-IP si el peer socket es loopback; de lo contrario IP socket. CF-Connecting-IP y X-Forwarded-For del cliente se ignoran. Nginx `/mcp` observado sobrescribe X-Real-IP con `$remote_addr`; no se afirma normalización de IP Cloudflare.
- POST MCP: máximo **64 KiB de bytes reales**, también chunked; 413 si excede, 400 ante JSON inválido/timeout de lectura (10 s). Aborto se limpia sin ejecutar tools; si socket ya cerró no puede entregarse respuesta.
- API upstream: timeout 30 s, sin redirects.
- `GET /health` local: `{"status":"ok","version":"1.0.0","transport":"streamable-http"}`. Liveness, no readiness del backend. Routing público pendiente del operador.

## Verificación local

```sh
cd mcp-server
npm ci
npm test
npm run typecheck
npm run build -- --outDir .verification-build
MCP_SMOKE_BUILD=1 ./node_modules/.bin/tsx --test test/server.test.ts test/boundaries.test.ts
```

Smoke: loopback, puertos efímeros y backend mock, sin producción. Plan de 14 días y siguiente `renewal_opportunities`: [plan](plans/mcp-primordial-2026-09-06.md). Su implementación sigue fuera del release.
