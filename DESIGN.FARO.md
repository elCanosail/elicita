# DESIGN.md — FARO · elicita datos abiertos

*Sistema visual de la capa pública de elicita_.*
*Formato: Google Stitch (https://stitch.withgoogle.com/docs/design-md/format/)*
*Dirección de arte ratificada por Chema (F0, 2026-09-16): registro dual — capa pública cívica clara + capa privada terminal-dark, ADN compartido.*

---

## Overview

FARO es la cara pública y humana de los datos abiertos de contratación pública española. Transmite **serenidad, claridad cívica y firmeza documental**. No es un dashboard: es una publicación de datos con oficio editorial.

- **Producto:** fichas-sector prerenderizadas, catálogo `/datos-abiertos`, case studies. Cero JS de lectura.
- **Stack:** Astro 5 (prerender) + SVG calculado en build + CSS puro. Sin frameworks de UI.
- **Relación con el producto elicita_**: comparte ADN (esmeralda, mono para cifras, voz editorial) pero respira en registro propio: luz, papel, calma. La capa privada (Dashboard/MCP) conserva el terminal oscuro; el salto visual entre capas es parte del relato freemium.
- **Referentes:** GOV.UK (claridad y acceso), FT/OWID (craft de datos), Civio (cívico español). **Anti-referente:** portales institucionales blancos, grises y descuidados.

## Philosophy

- **La firmeza de los datos.** Cada cifra lleva fuente, fecha y checksum a la vista. La trazabilidad es componente protagonista, no letra pequeña.
- **Sereno, no lento.** Espacio generoso, ritmo tipográfico, color contenido. La calma transmite autoridad.
- **Honesto por diseño.** Lo "no resuelto" se declara con la misma tipografía y calma que lo resuelto. Los vacíos son contenido, no vergüenza.
- **Cero JS para leer.** Todo lo esencial existe como HTML+SVG estático. Si requiere JS, es mejora progresiva (islands), nunca el contenido.
- **Cifras tabulares.** Los números van en mono con dígitos tabulares: la alineación es parte de la credibilidad.
- **El dato manda sobre la decoración.** Nada ornamental que no porte información.

## Color System

OKLCH; neutros teñidos hacia el esmeralda (hue ~163) para cohesión subconsciente con la marca. Nunca negro ni blanco puros.

### Superficies

| Token | Value | Usage |
|-------|-------|-------|
| `paper` | `oklch(0.977 0.005 160)` | Fondo de página |
| `paper-raised` | `oklch(0.955 0.008 160)` | Sello FARO, bloques destacados |
| `paper-deep` | `oklch(0.93 0.012 160)` | Cabeceras de tabla, hover |

### Tinta

| Token | Value | Usage |
|-------|-------|-------|
| `ink` | `oklch(0.25 0.02 165)` | Titulares, texto primario |
| `ink-2` | `oklch(0.42 0.025 165)` | Cuerpo |
| `ink-3` | `oklch(0.55 0.02 165)` | Metadatos, captions |
| `ink-faint` | `oklch(0.70 0.015 165)` | Decorativo, deshabilitado |

### Acentos y señal

| Token | Value | Usage |
|-------|-------|-------|
| `civic` | `oklch(0.50 0.11 163)` | Acento de texto AA sobre papel, enlaces, foco |
| `emerald` | `oklch(0.72 0.15 162)` ≈ `#10b981` | Relleno de gráficos, marcas — ADN compartido con elicita_ |
| `amber` | `oklch(0.60 0.12 75)` | "No resuelto", parciales, avisos honestos |
| `line` | `oklch(0.88 0.01 160)` | Filetes 1px, bordes |

### Paleta de gráficos (daltónica-safe, máx. 3 por gráfico)

1. Esmeralda `oklch(0.72 0.15 162)` · 2. Azul `oklch(0.55 0.13 245)` · 3. Ámbar `oklch(0.78 0.14 80)` · 4. Granate `oklch(0.55 0.14 25)` · 5. Celeste `oklch(0.78 0.09 220)`

## Typography

Tres voces, cada una con un único trabajo:

| Rol | Fuente | Pesos | Usage |
|-----|--------|-------|-------|
| Narrativa | **Source Serif 4** | 400 / 600 | Titulares, lede, editorial |
| Interfaz | **Instrument Sans** | 400 / 500 / 600 | UI, tablas, labels, captions |
| Cifras | **JetBrains Mono** | 400 / 600 | Todo número, id, checksum — `font-variant-numeric: tabular-nums` |

- Escala fluida con `clamp()`: de `--step--1: clamp(0.78rem, 0.75rem + 0.2vw, 0.85rem)` a `--step-5: clamp(2.6rem, 2rem + 3vw, 4.2rem)`.
- Interlineado: 1.15 titulares, 1.65 cuerpo. Medida de lectura: 66–72ch.
- Números en formato español: miles con punto, decimales con coma (3.755 M€ · 88,9%).

## Data Visualization

- **Cero JS:** todo gráfico es SVG estático generado en build desde los artefactos del snapshot.
- Barras con baseline en cero siempre. Sin gridlines salvo el eje base. Etiquetado directo sobre la marca; no leyendas desacopladas.
- Cada gráfico lleva caption de procedencia: `Fuente: {artefacto}.csv · snapshot {id} · CC BY 4.0`.
- Los periodos parciales se marcan explícitamente (ámbar + nota "parcial").
- Toda serie lleva tabla accesible (visible o sr-only) con las mismas cifras.
- Prohibido: 3D, donuts para series temporales, degradados decorativos, sparklines ornamentales.

## Components

1. **Masthead FARO** — `elicita_` en mono + sello "FARO · datos abiertos" + nav mínima (Sectores · Descarga · MCP). Hairline inferior.
2. **Lede hero** — kicker mono (sector + CPV), titular serif, párrafo-lede con las cifras clave integradas en la frase, badge de snapshot (id + fecha de corte).
3. **Sello FARO** (trazabilidad) — panel `paper-raised` con borde 1px: snapshot_id, fecha, schema, methodology, fuente, licencia, `checksums.sha256` enlazado, descargas. Es la firma visual: certificado, no footer legal.
4. **Bloque honestidad** — ledger de cobertura con hairlines; estados "no resuelto" con chip ámbar y explicación de una línea.
5. **Ranking con barras** — tabla editorial: posición serif, nombre sans, barra esmeralda proporcional, cifra mono; NIF en mono pequeño.
6. **Puente freemium** — una línea, sin ventas: "Estos datos son abiertos. La profundidad — grafo, radar, análisis — vive en el MCP privado." Enlace al producto.
7. **Footer** — elicita_ + licencia + nota de fuente (PLACSP/TED).

## Layout & Space

- Grid editorial asimétrico, alineado a la izquierda siempre. Contenido principal máx. 72rem; texto de lectura 66–72ch.
- Márgenes amplios: `clamp(1.25rem, 4vw, 4rem)`.
- Ritmo variado: secciones separadas por hairline + índice mono ("01 — Serie anual"). Nada de tarjetas idénticas repetidas; jerarquía por tamaño y espacio, no por cajas.

## Motion

Estático por naturaleza. Solo estados hover/focus (120ms ease-out en color y borde). Respeta `prefers-reduced-motion`. Sin animaciones de entrada.

## Accessibility

- AA mínimo: `ink`/`paper` ≈ 13:1; `civic` sobre papel ≥ 4.5:1; nunca `emerald` claro como texto.
- Foco visible 2px `civic`. Paleta de gráficos daltónica-safe. Tabla accesible para toda serie. HTML semántico (`figure`/`figcaption`/`table`).

## Voice

Español preciso y llano. Cifras con unidades y periodos explícitos. "No resuelto" sin eufemismos ni disculpas. Sin exclamaciones. El tono de un registro público, no de un anuncio.
