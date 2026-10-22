# CHANGELOG — elicita_

## 2026-03-02 (tarde)

### Monitor y Explorer rediseñados
- **Grid → Tabla**: layout de tarjetas reemplazado por tabla con scroll fijo y columnas ordenables
- **Títulos completos**: objeto del contrato sin truncar, con `word-break` y tooltip nativo
- **Filtro CPV mejorado**: dropdown ancho fijo (380px), scroll interno, nombres prominentes, acciones bulk (Todos / Ninguno / Perfil)
- **Filtro por importe**: 6 horquillas (<50K, 50K-200K, 200K-1M, 1M-5M, >5M, Sin importe), multi-selección
- **Filtro por estado**: Abierta, Publicado, Anuncio previo, Evaluación, Resuelta, Adjudicada — pre-selecciona activas
- **Scroll arrows**: flechas ↑↓ para ir a inicio/final del listado, scrollbar emerald visible
- **CPVs perfil pre-seleccionados**: usa `cpvs_seleccionados` del onboarding (o fallback a `cpvs_activos`)
- **Explorer**: tabla con columnas sortables (Organismo, CPV, Próxima est., Intervalo, Confianza)

### Onboard 2 pasos
- **Step 1**: CIF + nombre → profiling automático contra 54.6M registros
- **Step 2**: CPVs históricos detectados, ordenados por contratos, top 30 pre-seleccionados
- Acciones bulk: Todos / Ninguno / Top 20, búsqueda por nombre/código
- **PATCH `/api/profile`**: nuevo endpoint para guardar `cpvs_seleccionados` en perfil

### Fichas de contrato
- Objeto del contrato primero y prominente (16px), organismo secundario
- URL fuente original auto-generada desde ID (TED → ted.europa.eu, BOE → boe.es)
- Fix rutas con `/` en IDs (358 contratos PLACSP afectados): `[id].astro` → `[...id].astro`

### Home
- H1: "Saber antes, preparar mejor, llegar primero." (sustituye "La esencia del éxito")
- Dos contadores principales: 54.6M registros (emerald) + 987B€ volumen (amber)
- Gráfico dataset con segunda curva económica (volumen licitado, amber)
- Contadores live en gráfico: registros + volumen M€ procesados hoy
- CTA: "Solicitar acceso →" (sustituye "Probar gratis")
- Meta description actualizada

### Metodología
- Claim "Saber antes, preparar mejor, llegar primero." tras origen del nombre, antes de "El reto"
- Eliminada duplicación de frase

## 2026-03-02 (mañana)

### Monitor con filtros CPV interactivos
- **Filtros CPV**: multi-select dropdown con nombres en español (9,454 códigos)
- **Ordenación**: fecha (reciente), importe ↑↓
- **Badges de fuente**: colores por origen (TED, PLACSP, DOGA, BOE, DOGV...)
- **Auto-discover fuentes**: `data.ts` refactorizado para leer dinámicamente todos los `*_contracts.json`
- **Diccionario CPV oficial**: descargado de PLACSP Genericode (`CPV2008-2.04.gc`), 9,454 entradas
- **Nuevo endpoint**: `/api/cpv` para servir diccionario

### Conector PLACSP datos abiertos
- Nuevo conector `placsp.js` — feed ATOM de contratación estatal
- 473 contratos, 99.2% con CPV
- Integrado en scheduler: ejecución diaria a 06:00 UTC

### Sidebar simplificado
- Monitor y Explorer como items directos (📡 / 🔭)
- Eliminadas subsecciones "Licitaciones" y "Predicciones"

## 2026-03-01

### Conectores dinámicos ampliados a 9
- PLACSP en desarrollo, DOGV integrado
- BOE optimizado a ventana de 7 días
- Scheduler unificado: TED/PLACE/DOGA/BOE/DOGV cada 4h

### Dashboard e-xplorer
- 5 secciones: Pipeline, Resumen, Competencia, Mercado, Alertas
- Alertas dinámicas desde datos TED reales
- Filtros combinables en pipeline
- Renovaciones con 50 ciclos de predicción

### Onboarding automático
- Ingreso CIF → perfil en ~3 min (profiler_v2)
- 3,123 adjudicaciones para Applus (cliente test)
- 30 competidores, 276 CPVs activos

### Infraestructura
- Clerk auth (dark mode, español)
- Multi-tenant por CIF
- PM2 para web + ingesta
- Nginx + SSL (Let's Encrypt)
- Backups GDrive con política GFS
