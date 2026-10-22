# elicita_

Inteligencia sobre contratación pública española y europea.

**Perfilado automático por CIF** → Dashboard personalizado en 5 minutos.

> **Estado: proyecto archivado (octubre 2026).** Elicita operó en producción
> hasta octubre de 2026; este repositorio se publica como referencia al
> retirarla del servicio y no recibe mantenimiento.

## Qué hacía

- **Buscador** de licitaciones por texto, CPV, provincia, importe, estado y órgano.
- **Perfilado automático por CIF** contra el histórico completo de adjudicaciones.
- **Fichas SSR** de licitación y contratante con marcado schema.org (JSON-LD).
- **Alertas por email** de coincidencias y seguimiento de expedientes.
- **Market Intelligence open data**: 7 datasets sectoriales (tecnología,
  construcción, salud, energía, limpieza, defensa, transporte) con metodología
  documentada, taxonomías versionadas, registro de exclusiones con evidencia y
  determinismo verificado del generador.
- **Servidor MCP** (v1/v2) para integración con agentes IA.

## Escala

- 66,4M registros agregados: 30,9M licitaciones + 26,3M BORME + 8,7M calidad + 488K NIF
- 11 conectores de ingesta: PLACSP (ATOM/ZIP), TED, BOE/BORME y portales autonómicos
- 7 datasets de market intelligence publicados con metodología abierta

## Stack

- **Web:** Astro 5 + Tailwind + TypeScript (SSR) · Clerk · Resend
- **Datos:** DuckDB embebido (BD columnar con el corpus materializado)
- **Ingesta:** Python + Node, con control de rate limits y ciclo delta/bulk
- **MCP:** Model Context Protocol, servidor dual (v1/v2)
- **Infra:** Hetzner VPS + Nginx + PM2 (systemd)

## Documentación

| Archivo | Contenido |
|---------|-----------|
| [VISION.md](VISION.md) | Principios, posicionamiento, filosofía de producto |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Dataset, conectores, profiler, endpoints |
| [docs/API.md](docs/API.md) | Referencia API — endpoints v1, auth, fuentes |
| [docs/CLI.md](docs/CLI.md) | Guía de uso del CLI `elicitac` |
| [docs/MCP.md](docs/MCP.md) | MCP server para integración con agentes IA |
| [docs/plans/open-data-market-intelligence-v1.md](docs/plans/open-data-market-intelligence-v1.md) | Metodología del generador open data |
| [CHANGELOG.md](CHANGELOG.md) | Historial de cambios |

## Estructura

```
web/          Aplicación Astro (SSR + API routes)
ingesta/      Conectores, materialización y scheduler de ingesta
mcp-server/   Servidor MCP + generador de datasets open data
cli/          CLI `elicitac`
scripts/      Utilidades: parsers, evals, verificaciones
ops/          Nginx y worker de uptime
docs/         Documentación (API, CLI, MCP, metodología)
```

## Qué no incluye este repositorio

El corpus de datos se deriva íntegramente de fuentes públicas con el pipeline
de `ingesta/` y no se distribuye aquí. Tampoco incluye claves ni configuración
de producción: ver `web/ecosystem.config.example.json` y
`mcp-server/.env.example`.

## CLI

`npm install -g @elcanosail/elicitac` — ver [docs/CLI.md](docs/CLI.md).

## Licencia

[MIT](LICENSE)

---

*Convertir complejidad en claridad.*
