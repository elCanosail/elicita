# ARCHITECTURE.md — Arquitectura de datos elicita_

## Principios fundamentales

### 1. Ingesta completa, filtrado por cliente
**Los conectores NO filtran datos.** Capturan TODO lo disponible de cada fuente.
El filtrado (por CPV, organismo, geografía, etc.) se aplica en un segundo paso,
a nivel de cliente, en el profiler y el dashboard.

Esto garantiza:
- Base de datos completa y reutilizable para cualquier cliente/sector
- Sin sesgo de ingesta — cualquier empresa puede perfilarse sin recargar datos
- Máximo valor del dataset histórico + dinámico

### 2. Cero datos inventados
Cada dato mostrado procede de una fuente oficial verificable.
Proyecciones derivadas de datos reales se etiquetan [PROYECCIÓN].

### 3. Dos bloques, una inteligencia

```
┌─────────────────────────────────────────────────────────────┐
│                    BLOQUE 1: HISTÓRICO                       │
│              Dataset estático — 65.9M registros              │
│                                                              │
│  Fuente: BquantFinance/licitaciones-espana (v2026.02)        │
│  Almacén: DuckDB (2.3 GB)                                   │
│  Actualización: mensual (check-dataset-update.sh)            │
│                                                              │
│  → Perfilado por CIF: adjudicaciones, competidores, ciclos   │
│  → Predicciones de renovación                                │
│  → Calidad de datos: 20 indicadores × 8.7M contratos        │
│  → Cruce BORME: estructura societaria                        │
└─────────────────────┬───────────────────────────────────────┘
                      │  DuckDB queries
                      ▼
            ┌─────────────────────┐
            │   MOTOR ELICITA     │
            │   Fusión + Scoring  │
            │   + Predicción      │
            └─────────┬───────────┘
                      ▲
                      │  JSON files + API
┌─────────────────────┴───────────────────────────────────────┐
│                    BLOQUE 2: DINÁMICO                         │
│           Ingesta en tiempo real — 13 conectores             │
│                                                              │
│  Frecuencia: cada 4h (PM2 cron)                              │
│  Almacén: JSON en /ingesta/data/ (merge incremental)         │
│                                                              │
│  → Feed completo: TODO lo publicado, sin filtro              │
│  → Alertas: deadlines, nuevas oportunidades                  │
│  → Pipeline activo: contratos abiertos ahora mismo           │
└─────────────────────────────────────────────────────────────┘
```

---

## BLOQUE 1: Dataset histórico (65.9M registros)

### Tablas en DuckDB

| Tabla | Registros | Fuente | Notas |
|-------|-----------|--------|-------|
| **borme_cargos** | 17,101,151 | BOE (Registro Mercantil) | Cargos societarios, anonimizado |
| **nacional** | 13,419,448 | PLACSP (datos.gob.es) | Core contratación estatal |
| **borme_empresas** | 9,254,668 | BOE (Registro Mercantil) | Estructura societaria |
| **calidad** | 8,693,891 | BQuant (20 indicadores) | score_calidad 57.9–100.0 |
| **ted** | 6,478,599 | TED EU (API v3 + CSV) | Contratos >umbral SARA |
| **comunidad_madrid** | 2,563,527 | Portal CM Open Data | |
| **madrid_ayto** | 2,563,527 | Ayto Madrid Open Data | |
| **catalunya** | 1,995,455 | Transparència Catalunya | Solo contratación |
| **galicia** | 1,685,789 | contratosdegalicia.gal | |
| **andalucia** | 808,441 | Junta de Andalucía | |
| **euskadi** | 713,827 | KontratazioA / Open Data | |
| **asturias** | 375,380 | Sede Asturias | |
| **valencia** | 246,337 | GVA Open Data | |
| **TOTAL** | **65,900,040** | | **2.3 GB** |

### Tabla de calidad (8.7M contratos × 70 columnas)

20 indicadores booleanos por contrato (framework PPDS):
- **INT-VAL-xx** — Validez (tiene objeto, importe, CPV, etc.)
- **INT-CONS-xx** — Consistencia (fechas coherentes, importes razonables)
- **INT-FIA-xx** — Fiabilidad (adjudicatario identificado, NIF válido)
- **score_calidad** — Agregado 57.9–100.0 (media 88.3, mediana 89.5)
- **487,600 NIFs únicos** con score calculado

### Licencia de datos
Todos los datos son públicos y reutilizables comercialmente:
- **PLACSP/CCAA:** Ley 37/2007 de reutilización — uso comercial con atribución
- **TED:** EU Open Data Licence — comercial permitido
- **BORME:** Condiciones BOE reutilización — comercial permitido
- Atribución de fuentes oficiales en `/cobertura`

### Ubicación física

```
/var/data/licitaciones/
├── raw/              # ZIPs/RARs originales del release
├── data/             # Parquets extraídos por fuente
│   ├── nacional/
│   ├── ted/
│   ├── borme/
│   ├── calidad/      # calidad_licitaciones_resultado.parquet (977MB)
│   ├── catalunya/
│   ├── galicia/
│   ├── andalucia/
│   ├── euskadi/
│   ├── asturias/
│   ├── comunidad_madrid/
│   ├── madrid_ayto/
│   └── valencia/
├── db/
│   └── licitaciones.duckdb   # 2.3 GB
├── scripts/
│   └── load.py               # Extrae + carga parquets → DuckDB
└── .installed_version         # Tag del release instalado
```

### Actualización
```bash
# Automático (cron 04:00 UTC)
/root/.openclaw/workspace/projects/elicita/ingesta/scripts/check-dataset-update.sh

# Manual
bash check-dataset-update.sh --force
```

---

## BLOQUE 2: Ingesta dinámica (tiempo real)

### Principio: captura completa, sin filtro

Todos los conectores capturan TODO lo disponible de su fuente.
NO hay filtros por CPV, keyword, cliente ni sector.
El filtrado se aplica downstream (profiler, dashboard, alertas).

### Conectores activos (13 fuentes)

| # | Conector | Fuente | Método | Notas |
|---|----------|--------|--------|-------|
| 1 | `ted.js` | **TED EU** | API v3 — todos ESP, paginado | Hasta 2000/ciclo |
| 2 | `place.js` | **PLACE/TED** | API v3 — todos ESP, 90 días | Sin filtro CPV |
| 3 | `boe.js` | **BOE** | XML sección 5A completa | 7 días, 3x parallel |
| 4 | `doga.js` | **DOGA** (Galicia) | PLACE feed filtrado CCAA | Completo |
| 5 | `dogv.js` | **DOGV** (Valencia) | PLACE feed filtrado CCAA | Completo |
| 6 | `andalucia_v2.js` | **Andalucía** | ElasticSearch API | 853K expedientes |
| 7 | `catalunya.js` | **Catalunya** | API REST PSCP | 500/ciclo |
| 8 | `euskadi_v2.js` | **Euskadi** | Open Data JSON anual | 11K+ en ventana |
| 9 | `madrid_cm.js` | **Madrid CM** | Antibot + CAPTCHA + CSV | 50K/ciclo |
| 10 | `madrid_ayto.js` | **Madrid Ayto** | CSV Open Data | |
| 11 | `galicia_v2.js` | **Galicia** | API REST DataTables | 160 organismos |
| 12 | `placsp.js` | **PLACSP** | Feed ATOM datos abiertos | Diario 06:00 |
| 13 | `profiler_v2.py` | **Profiler** | DuckDB queries | Bajo demanda |

### Conectores desactivados

| Conector | Razón |
|----------|-------|
| `valencia_v2.js` | Redundante con DOGV (RT) + DuckDB histórico (246K) |
| `andalucia.js` | Sustituido por `andalucia_v2.js` (ElasticSearch) |
| `euskadi.js` | Sustituido por `euskadi_v2.js` (Open Data JSON) |
| `madrid.js` | Sustituido por `madrid_cm.js` (antibot) |
| `profiler.js` | Sustituido por `profiler_v2.py` (DuckDB) |

### Merge incremental

Todos los conectores usan `lib/merge.js` para:
- Acumular contratos sin sobrescribir
- Deduplicar por ID
- Tracking: `_first_seen`, `_merged_at`
- Purga inteligente de registros obsoletos

### Scheduler

```javascript
// scheduler.js — cada 4h (cron '0 */4 * * *')
// PLACSP — diario a las 06:00 (cron '0 6 * * *')
```

### Ubicación física

```
/root/.openclaw/workspace/projects/elicita/ingesta/
├── connectors/        # 18 conectores (13 activos)
├── lib/merge.js       # Merge incremental por ID
├── data/              # JSON outputs + status.json
├── logs/              # Logs por conector
└── scheduler.js       # Orquestador PM2
```

---

## Flujo cliente

```
CLIENTE → introduce CIF
              │
              ▼
    BLOQUE 1 (DuckDB 65.9M)
    ├── nacional: adjudicaciones por NIF
    ├── ted: contratos europeos
    ├── calidad: score por empresa
    ├── borme: estructura societaria
    └── → CPVs, competidores, ciclos, bajas
              │
              ▼
    PROFILER (profiler_v2.py)
    → Perfil completo en ~5 min
              │
              ▼
    BLOQUE 2 (dinámico, sin filtro)
    → Filtrar por CPVs del perfil
    → Pipeline personalizado
    → Alertas automáticas
              │
              ▼
    DASHBOARD / EXPLORER
```

---

## Stack técnico

| Capa | Tecnología |
|------|------------|
| **Frontend** | Astro 5 + React + Tailwind |
| **Backend** | Astro SSR (Node adapter) |
| **DB histórica** | DuckDB 2.3 GB (read-only) |
| **DB dinámica** | JSON files (merge incremental) |
| **Auth** | Clerk (dev, pendiente prod) |
| **Pagos** | Stripe (4 planes, €49–599/mes) |
| **Ingesta** | Node.js scheduler + Python profiler |
| **Infra** | PM2 + nginx + Hetzner VPS |
| **Código** | ~23K LOC (16.6K web + 6.7K ingesta) |

---

## Endpoints API

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/data` | GET | Contratos dinámicos (auto-discover JSON) |
| `/api/profile` | GET/PATCH | Perfil cliente (CPVs, competidores) |
| `/api/cpv` | GET | Diccionario CPV (9,454 códigos ES) |
| `/api/alertas` | GET | Alertas dinámicas |
| `/api/onboard` | POST/GET | Onboarding: CIF → profiler → jobId/poll |
| `/api/cobertura` | GET | Estado fuentes + contadores live |
| `/api/stats` | GET | Estadísticas agregadas |
| `/api/stripe/checkout` | POST | Crear sesión Stripe |
| `/api/stripe/webhook` | POST | Lifecycle suscripciones |
| `/api/contact` | POST | Formulario contacto |

---

*Última actualización: 10 Mar 2026*
