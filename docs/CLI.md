# elicitac — Guía de uso

> **Versión:** v0.3.0 | **Repositorio:** [github.com/elCanosail/elicita](https://github.com/elCanosail/elicita) → `cli/`

`elicitac` es la interfaz de línea de comandos de [Elicita](https://elicita.es). Permite buscar, exportar y analizar 66.4M+ registros de contratación pública española desde la terminal, con salidas estructuradas (`--json`) pensadas para integraciones automatizadas y agentes IA.

---

## Instalación

### Opción A — npm (recomendada)

```bash
npm install -g @elcanosail/elicitac

# Verifica
elicitac version
# → elicitac v0.3.0
```

El instalador descarga automáticamente el binario precompilado para tu plataforma (linux/darwin/windows × amd64/arm64) desde GitHub Releases. No necesitas Go instalado.

### Opción B — Binario directo

Descarga el binario desde [GitHub Releases](https://github.com/elCanosail/elicita/releases/latest):

```bash
# Linux amd64
curl -L https://github.com/elCanosail/elicita/releases/latest/download/elicitac-linux-amd64 -o elicitac
chmod +x elicitac
sudo mv elicitac /usr/local/bin/
```

### Opción C — Compilar desde fuente

```bash
git clone https://github.com/elCanosail/elicita
cd elicita/cli
CGO_ENABLED=0 go build -ldflags="-s -w" -o elicitac ./cmd/elicita
```

Requiere Go 1.22+.

---

## Configuración

### API Key

Para usar el CLI necesitas una API key de Elicita (plan Enterprise o Trial):

```bash
elicitac auth --key elc_tu_api_key_aqui
```

La clave se guarda en `~/.elicitac/config.json` con permisos 0600. Verifica que funciona:

```bash
elicitac whoami
# → Authenticated as elc_xxxx... (plan: enterprise)
```

### Endpoint personalizado

Si tienes una instancia propia o staging:

```bash
elicitac auth --key elc_xxxx --endpoint https://staging.elicita.es
```

---

## Comandos

### `search` — Búsqueda de contratos

Búsqueda full-text sobre todas las tablas de contratación (30.9M licitaciones).

```bash
# Búsqueda básica
elicitac search "mantenimiento HVAC"

# Con filtros
elicitac search "software" --cpv 72 --desde 2024 --min 50000 --json --limit 20

# Por adjudicatario
elicitac search "Telefónica" --nif A78901234 --desde 2024 --json
```

**Filtros disponibles:**

| Flag | Descripción | Ejemplo |
|------|-------------|---------|
| `--cpv` | Código CPV (prefix match) | `--cpv 72` (servicios TI) |
| `--nif` | NIF del adjudicatario | `--nif B15044357` |
| `--estado` | Estado del contrato | `--estado Adjudicada` |
| `--fuente` | Fuente de datos | `--fuente PLACE` |
| `--desde` | Año desde | `--desde 2024` |
| `--hasta` | Año hasta | `--hasta 2026` |
| `--min` | Importe mínimo (€) | `--min 100000` |
| `--max` | Importe máximo (€) | `--max 5000000` |
| `--limit` | Resultados (default 20, max 100) | `--limit 50` |
| `--offset` | Paginación | `--offset 20` |
| `--sort` | Campo de orden | `--sort importe` |
| `--dir` | Dirección | `--dir desc` |
| `--json` | Salida JSON | |

**Fuentes disponibles:** PLACSP (nacional), TED (Europa), Andalucía, Catalunya, Euskadi, Galicia, Valencia, Aragón, Madrid CM, Madrid Ayto, Asturias, BORME

---

### `org` — Ficha de empresa

Perfil completo de una empresa por NIF: nombre, total de contratos adjudicados, volumen económico acumulado, listado de contratos y enriquecimiento con datos del BORME (domicilio, capital, fecha de constitución).

```bash
# Tabla legible
elicitac org B15044357

# JSON para pipes
elicitac org B15044357 --json | jq '.volumen_total'
```

**Requiere:** plan Enterprise o Trial.

---

### `predict` — Predicción de renovaciones

Estima próximas oportunidades de contratación para un adjudicatario basándose en el patrón histórico de sus contratos.

```bash
# Predicción a 12 meses (default)
elicitac predict B15044357

# Ventana de 24 meses, salida JSON
elicitac predict B15044357 --months 24 --json
```

**Algoritmo:**

1. Obtiene el histórico de contratos del NIF vía `/api/v1/org/<nif>`
2. Agrupa contratos por organismo (o CPV si no hay organismo)
3. Para cada grupo con ≥2 contratos:
   - Calcula el intervalo promedio entre contratos consecutivos (en meses)
   - Estima la próxima fecha de licitación: último contrato + intervalo promedio
   - Calcula el valor estimado: promedio de importes del grupo
   - Asigna confianza: **baja** (1-2 contratos), **media** (3-5), **alta** (6+)
4. Filtra solo predicciones dentro de la ventana `--months`
5. Ordena por fecha estimada ascendente

**Output tabla:**

```
ORGANISMO              ÚLTIMO CONTRATO  INTERVALO  PRÓXIMA EST.  VALOR EST.  CONFIANZA
Ayuntamiento Sevilla   2024-03-15       18 meses   2025-09-15    45.000€    media
Red.es                 2024-11-20      12 meses   2025-11-20    120.000€   alta
```

**Output `--json`:**

```json
{
  "nif": "B15044357",
  "nombre": "APPLUS NORCONTROL SL",
  "predicciones": [
    {
      "organismo": "Ayuntamiento de Sevilla",
      "cpv": "72000000",
      "total_contratos": 5,
      "ultimo_contrato": "2024-03-15",
      "intervalo_promedio_meses": 18,
      "proxima_estimada": "2025-09-15",
      "valor_estimado": 45000.0,
      "confianza": "media"
    }
  ],
  "meta": {
    "total_grupos": 3,
    "dentro_de_meses": 12
  }
}
```

---

### `export` — Exportación masiva

Descarga resultados de búsqueda a CSV o JSONL con paginación automática.

```bash
# CSV (default) — abre en Excel/Google Sheets
elicitac export "HVAC" --csv > hvac.csv

# JSONL — para pipes y ingesta
elicitac export "software" --jsonl | jq '.titulo'

# Con filtros, límite de seguridad a 1000 resultados
elicitac export "consultoría" --cpv 72 --desde 2024 --csv > consultoria_2024.csv
```

El progreso se muestra en stderr (no contamina stdout). Cap de seguridad: 1000 resultados por consulta.

---

### `stats` — Estadísticas rápidas

Totales agregados por fuente, CPV y año.

```bash
# Estadísticas globales
elicitac stats

# Filtradas
elicitac stats --cpv 72 --fuente PLACE --year 2025 --json
```

---

### `alerts` — Gestión de alertas

Crea, lista y elimina alertas de búsqueda. Funciona con API key Bearer o sesión web Clerk.

```bash
# Listar alertas
elicitac alerts --list

# Crear alerta
elicitac alerts --create --query "mantenimiento HVAC" --cpv 72,48

# Eliminar alerta
elicitac alerts --delete default
```

**Plan free:** 1 alerta. **Plan Pro:** alertas ilimitadas + alertas de competidores. **Plan Empresa:** todo.

---

### `graph` — Grafo de relaciones

Visualiza relaciones entre organismos y adjudicatarios.

```bash
elicitac graph "Red.es" --type organismo --json
elicitac graph "B15044357" --type adjudicatario --cpv 72 --year 2025
```

---

### `auth` y `whoami` — Autenticación

```bash
# Guardar API key
elicitac auth --key elc_xxxxxxxx

# Verificar estado
elicitac whoami
```

### `version`

```bash
elicitac version
# → elicitac v0.3.0
```

---

## Exit codes

| Código | Significado | Cuándo |
|--------|-------------|--------|
| 0 | OK | Operación exitosa |
| 1 | Error genérico | Error de red, parseo, argumentos |
| 2 | Auth | API key inválida o expirada |
| 3 | Rate limit | Demasiadas peticiones |

---

## Casos de uso

### 1. Prospección comercial

```bash
# ¿Quién contrata HVAC en Madrid?
elicitac search "HVAC" --fuente "Madrid CM" --estado Adjudicada --json | jq '.[] | {organismo, importe, fecha}'

# ¿Cuánto negocio tiene Applus en Andalucía?
elicitac org B15044357 --json | jq '.volumen_total'

# ¿Qué oportunidades vienen para ellos?
elicitac predict B15044357 --months 12 --json
```

### 2. Export para BI

```bash
# Exportar licitaciones de software 2024-2026 para Power BI
elicitac export "software" --cpv 72 --desde 2024 --csv > software_licitaciones.csv
```

### 3. Monitorización con cron

```bash
# Diario: nuevas licitaciones de interés
0 9 * * * elicitac search "mantenimiento" --cpv 50 --desde 2025 --json >> /var/log/licitaciones.jsonl
```

### 4. Integración con agentes IA

```bash
# Pipe a un LLM para análisis
elicitac search "ciberseguridad" --json --limit 50 | jq '.[]' | llm -s "Resume las tendencias en contratación de ciberseguridad"
```

---

## Arquitectura

- **Binary único** estático (5MB, CGO_ENABLED=0, zero deps)
- **Config:** `~/.elicitac/config.json` (0600)
- **Logs:** stderr | **Datos:** stdout | **Exit codes:** scripting
- **Endpoints:** `/api/v1/search`, `/api/v1/org/<nif>`, `/api/graph`, `/api/alertas`, `/api/v1/keys`
- **Auth:** Bearer API key (header `Authorization: Bearer elc_xxx`)
- **Source:** Go 1.22, cero dependencias externas

---

*Última actualización: 27 Jun 2026 — v0.3.0*