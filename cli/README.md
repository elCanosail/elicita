# elicitac — Elicita CLI

Agent-friendly CLI for Spanish public procurement data.
Single static Go binary, zero runtime deps, structured `--json` output.

## Status: v0.3.0

Incluye el comando `predict` para estimar renovaciones de contratos por NIF de adjudicatario, junto con MCP server y distribución npm.

## Build

```bash
CGO_ENABLED=0 go build -ldflags="-s -w" -o elicitac ./cmd/elicita
```

## Usage

```bash
# Búsqueda general
elicitac search "mantenimiento HVAC" --json --limit 10
elicitac search "Telefónica" --nif A78901234 --desde 2024 --json

# Ficha de empresa por NIF
elicitac org B15044357 --json

# Predecir próximas renovaciones de un adjudicatario
elicitac predict B15044357 --months 18
elicitac predict B15044357 --json --months 24

# Exportar resultados a CSV/JSONL (paginación automática hasta 1000 resultados)
elicitac export "HVAC" --csv > hvac.csv
elicitac export "software" --jsonl | jq '.titulo'

# Estadísticas rápidas
elicitac stats --cpv 72 --fuente PLACE --json

# Alertas (requieren sesión web — ver nota más abajo)
elicitac alerts --list
elicitac alerts --create --query "mantenimiento HVAC" --cpv 72,48
elicitac alerts --delete default

# Grafo de relaciones
elicitac graph "Red.es" --type organismo --json

# Auth
elicitac auth --key elc_xxxxxxxx
elicitac whoami
```

## Exit codes

| Código | Significado |
|--------|-------------|
| 0      | OK |
| 1      | Error genérico |
| 2      | Error de autenticación |
| 3      | Rate limit |

## Design

- Single static binary (5MB, CGO_ENABLED=0)
- `--json` flag on every command for agent/pipe consumption
- Config at `~/.elicitac/config.json` (0600)
- Logs to stderr, data to stdout, exit codes for scripting
- Talks to `/api/v1/search`, `/api/graph` and `/api/alertas` on elicita.es

## Alertas

La gestión de alertas funciona tanto con sesión Clerk como con API key Bearer.

```bash
elicitac alerts --list
elicitac alerts --create --query "mantenimiento HVAC" --cpv 72,48
elicitac alerts --delete default
```

## Development

```bash
go test ./...
go vet ./...
go build ./...
```

## MCP Server

`elicitac-mcp` expone Elicita como un servidor MCP sobre stdio (JSON-RPC 2.0). Funciona con Claude Desktop, Cursor, y cualquier otro agente compatible.

### Build

```bash
CGO_ENABLED=0 go build -ldflags="-s -w" -o elicitac-mcp ./mcp/
```

### Configuración en Claude Desktop

Añade esto a `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "elicita": {
      "command": "/ruta/al/elicitac-mcp",
      "env": {
        "HOME": "/tu/home"
      }
    }
  }
}
```

Requisitos: el binary debe poder leer `~/.elicitac/config.json` (configura `elicitac auth` primero).

### Tools expuestos

- `elicitac_search` — búsqueda general
- `elicitac_org` — ficha por NIF
- `elicitac_stats` — estadísticas rápidas
- `elicitac_predict` — predicción mensual por NIF

Cada tool devuelve JSON estructurado igual que `elicitac <cmd> --json`.

## npm Distribution

Instala el CLI desde npm sin compilar:

```bash
npm install -g @elcanosail/elicitac

# O usa directamente sin instalar
npx @elcanosail/elicitac search "mantenimiento HVAC" --json --limit 10
```

El postinstall descarga el binary prebuilt correcto para tu plataforma desde GitHub Releases.

## CI / Release

- `.github/workflows/ci.yml` — tests, vet y smoke build en cada push/PR.
- `.github/workflows/release.yml` — builds cross-platform de `elicitac` y `elicitac-mcp`, GitHub Release con checksums en tags `v*`.
