# Elicita MCP v1 reducido

Servidor remoto TypeScript Streamable HTTP stateless en `https://elicita.es/mcp`. Referencia canónica completa: [docs/MCP.md](../docs/MCP.md). Go/stdio permanece legacy.

## Release cerrado

- Cuatro tools: `search_licitaciones`, `get_stats`, `get_cobertura`, `search_cpv`.
- Experimentales desregistradas siempre; `MCP_ENABLE_EXPERIMENTAL_TOOLS` no tiene efecto.
- Público o API key directa Bearer (`elicita_live_<32hex>_<48hex>`). Formato ≠ identidad verificada: backend valida key/plan/cuota. Nunca fallback público ante error.
- **Ruptura temporal: OAuth/discovery desactivados**, todas sus rutas devuelven 404; tokens OAuth anteriores devuelven 401. El handler heredado no se importa.
- **sort deshabilitado explícitamente**, incluyendo legacy `campo:dir`; devolverá error. Omitirlo usa el alias `fecha` del backend; `dir` sigue disponible.
- Body POST limitado a 64 KiB reales, incluyendo chunked; 413 por tamaño, 400 por JSON inválido/timeout, aborto limpio. El SDK recibe el JSON parseado una sola vez.
- CF/XFF de clientes ignorados. Solo X-Real-IP desde peer loopback; nginx `/mcp` lo sobrescribe con `$remote_addr`. Sin garantía añadida de normalización Cloudflare.
- `get_stats`: histórico, no contratos únicos. `get_cobertura`: ejecución global y actualización de cada fuente separadas. `generatedAt` no es frescura.

## Desarrollo

Node.js >=22. Variables: HOST (127.0.0.1), PORT (4326), ELICITA_API_URL (http://localhost:4321). El runtime no carga `.env` automáticamente: el operador debe suministrar variables por su mecanismo seguro. Nunca introducir claves en comandos, logs ni Git; la key llega por petición.

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

Health local `/health`: status/version/transport, sin secretos; solo liveness. Routing público no verificado.

La API es autoridad de cuota: pública 3 búsquedas/día/IP y autenticada según plan. Initialize/tools/list no consumen búsquedas. Errores backend 401/429 → error MCP, no fallback.

`duckdb@1.4.4` se conserva para compilar el código experimental, no se importa en runtime estable; instalación aún tiene transitivas obsoletas. Tests usan node:test y tsx existentes. Compilar antes de arrancar: los artefactos dist heredados no son fuente canónica.

## Sidecar SDK v2

`npm run start:v2` inicia un listener separado (`127.0.0.1:4327/mcp-v2` por defecto) con `createMcpHandler`: stateless legacy y 2026-07-28 desde la misma factoría/catálogo. Requiere `ELICITA_MCP_V2_ALLOWED_HOSTS` y `ELICITA_MCP_V2_ALLOWED_ORIGINS`; valida ambos antes de dispatch y conserva el límite de body v1. Su PM2 es independiente (`ecosystem.v2.config.cjs`) y el procedimiento de arranque/rollback está en [docs/runbooks/mcp-v2-sidecar.md](../docs/runbooks/mcp-v2-sidecar.md). No añade routing nginx ni despliega nada.
