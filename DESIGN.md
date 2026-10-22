# DESIGN.md — elicita_

*Sistema de inteligencia sobre contratación pública española.*
*Formato: Google Stitch (https://stitch.withgoogle.com/docs/design-md/format/)*
*Basado en: Diseño actual de producción (elicita.es)*

---

## Overview

**elicita_** es un SaaS de inteligencia competitiva para contratación pública española. 
Diseño dark-first, minimalista, tipografía monoespaciada como firma de identidad. 
Vibe: terminal elegante, datos en movimiento, precisión sin ruido.

**Stack:** Astro + React + Tailwind CSS + shadcn/ui + Clerk auth

---

## Philosophy

- **Dark by default.** `#080808` background, nunca blanco.
- **Monospace como ADN.** Logo, badges, data labels, terminal text — todo en JetBrains Mono / Space Mono.
- **Datos vivos.** Tickers, contadores, marquees. La información no espera.
- **Espacio negativo generoso.** No hay prisa en la pantalla.
- **Contraste sutil.** No negro puro vs blanco puro. Tonos de gris con un acento verde esmeralda.

---

## Color System

### Backgrounds

| Token | Value | Usage |
|-------|-------|-------|
| `bg-base` | `#080808` | Body, dashboard bg, sidebar |
| `bg-elevated` | `#111111` | Cards, modals, command palette |
| `bg-hovered` | `rgba(255,255,255,0.03)` | Hover states |
| `bg-active` | `rgba(16,185,129,0.05)` | Active nav item, selected row |

### Text

| Token | Value | Usage |
|-------|-------|-------|
| `text-primary` | `rgba(255,255,255,0.9)` | Headings, important labels |
| `text-secondary` | `rgba(255,255,255,0.7)` | Body text, descriptions |
| `text-muted` | `rgba(255,255,255,0.45)` | Metadata, timestamps, placeholders |
| `text-faint` | `rgba(255,255,255,0.2)` | Disabled, section labels |
| `text-inverse` | `#080808` | Text on emerald bg |

### Accent

| Token | Value | Usage |
|-------|-------|-------|
| `accent-emerald` | `#10b981` | Logo blink, active nav, CTAs, badges PRO |
| `accent-emerald-dim` | `rgba(16,185,129,0.12)` | Borders, backgrounds sutil |
| `accent-emerald-glow` | `rgba(16,185,129,0.06)` | Client badge bg |
| `accent-amber` | `#f59e0b` | Demo banner, warnings |
| `accent-amber-dim` | `rgba(245,158,11,0.08)` | Demo banner bg |

### Semantic

| Token | Value | Usage |
|-------|-------|-------|
| `border-subtle` | `rgba(255,255,255,0.05)` | Dividers, card borders |
| `border-active` | `rgba(16,185,129,0.12)` | Emerald borders |
| `status-online` | `#10b981` | Live indicators |
| `status-busy` | `#f59e0b` | Warnings |

### Tailwind CSS Variables

```css
:root {
  --background: 0 0% 3%;      /* #080808 */
  --foreground: 0 0% 95%;      /* rgba(255,255,255,0.95) */
  --card: 0 0% 5%;             /* #111111 */
  --card-foreground: 0 0% 95%;
  --primary: 0 0% 95%;         /* white-ish */
  --primary-foreground: 0 0% 3%;
  --secondary: 0 0% 8%;        /* #141414 */
  --secondary-foreground: 0 0% 70%;
  --muted: 0 0% 8%;
  --muted-foreground: 0 0% 45%;
  --accent: 0 0% 8%;
  --accent-foreground: 0 0% 95%;
  --destructive: 0 62.8% 30.6%;
  --destructive-foreground: 0 0% 95%;
  --border: 0 0% 10%;
  --input: 0 0% 10%;
  --ring: 152 60% 40%;         /* emerald focus ring */
  --radius: 0.375rem;          /* 6px */
  --emerald: 152 60% 40%;      /* #10b981 */
}
```

---

## Typography

### Font Stack

| Role | Font | Weights | Usage |
|------|------|---------|-------|
| **Sans (UI)** | Inter | 300, 400, 500 | Body, nav, buttons, cards |
| **Mono (Data)** | JetBrains Mono | 400, 500 | Logo, code, data labels, badges, terminal text |
| **Mono Alt** | Space Mono | 400, 700 | Headers en marketing page |

### Scale

| Token | Size | Line Height | Letter Spacing | Usage |
|-------|------|-------------|----------------|-------|
| `text-hero` | 48px | 1.1 | -0.02em | H1 landing |
| `text-h1` | 32px | 1.2 | -0.01em | Page titles |
| `text-h2` | 24px | 1.3 | 0 | Section headings |
| `text-h3` | 18px | 1.4 | 0 | Card titles |
| `text-body` | 14px | 1.6 | 0 | Body text |
| `text-small` | 13px | 1.5 | 0 | Nav items, descriptions |
| `text-xs` | 11px | 1.4 | 0.01em | Metadata, timestamps |
| `text-mono-xs` | 9px | 1.4 | 0.08em | Section labels (uppercase) |
| `text-mono-sm` | 11px | 1.4 | 0.05em | Data labels, client badge |

### Special Treatments

- **Logo:** `font-family: 'JetBrains Mono', monospace; font-size: 15px; letter-spacing: -0.5px;`  
  `elicita<span style="color:#10b981;animation:blink 1.2s infinite">_</span>`
- **Section labels:** `font-family: 'JetBrains Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(255,255,255,0.2);`
- **Data monospace:** `font-family: 'JetBrains Mono', monospace; font-size: 11px;` for numbers, CPVs, amounts

---

## Spacing

| Token | Value | Usage |
|-------|-------|-------|
| `space-page-x` | 32px | Horizontal padding in main content |
| `space-page-y` | 28px | Vertical padding in main content |
| `space-card` | 20px | Card internal padding |
| `space-section` | 48px | Between major sections |
| `space-tight` | 8px | Compact gaps (lists, inline) |
| `space-nav-item` | 8px 20px | Nav link padding |

---

## Border & Radius

| Token | Value | Usage |
|-------|-------|-------|
| `radius-sm` | 4px | Buttons, badges |
| `radius-md` | 6px | Cards, inputs |
| `radius-lg` | 8px | Modals, dropdowns |
| `radius-xl` | 12px | Command palette |
| `border-subtle` | 1px solid rgba(255,255,255,0.05) | Dividers, sidebar border |
| `border-emerald` | 1px solid rgba(16,185,129,0.12) | Client badge, active borders |

---

## Shadows

| Token | Value | Usage |
|-------|-------|-------|
| `shadow-modal` | `0 24px 64px rgba(0,0,0,0.6)` | Command palette |
| `shadow-card` | none (flat design) | Cards use border, never shadow |

---

## Layout

### Marketing Pages (públicas)

- **Header:** Sticky, backdrop-blur, border-bottom. Logo left, nav center, CTA right.
- **Hero:** Full-width, data ticker background, H1 + subtitle + CTAs.
- **Sections:** Container max-width ~1200px, centered.
- **Footer:** Multi-column, logo + description, links grouped.

### Blog editorial

- **Organización primaria:** colecciones editoriales, no categorías genéricas.
- **Colecciones:** Market Intelligence, Radiografía, Dossiers de compradores, Guías y producto.
- **Market Intelligence:** usa acento esmeralda y abre el índice con una explicación breve del programa.
- **Tarjetas:** planas, radio máximo 12px, borde sutil y sin sombras decorativas.
- **Metadatos:** fecha y tiempo en mono; colección visible antes del título.
- **Relaciones:** recomendar primero artículos de la misma colección editorial.
- **Confianza:** los rankings sectoriales deben enlazar metodología y mostrar cobertura antes de presentarse como cuotas de mercado.

### Dashboard (app autenticada)

```
┌─────────────────────────────────────────────┐
│ [Sidebar 220px]    │ [Main Content]         │
│                    │                        │
│  elicita_          │  ┌─ Demo Banner ─────┐│
│  [client badge]    │  └───────────────────┘│
│                    │                        │
│  MONITOR           │  [Header: title + actions]
│  ├─ Alertas        │                        │
│  ├─ Oportunidades  │  [Content...]          │
│                    │                        │
│  EXPLORER          │                        │
│  ├─ Renovaciones   │                        │
│  ├─ Competencia    │                        │
│  ├─ Mercado        │                        │
│  ├─ Historial      │                        │
│                    │                        │
│  [bottom links]    │                        │
└─────────────────────────────────────────────┘
```

- **Sidebar:** Fixed 220px, sticky top, full height. Dark bg `#080808`, right border.
- **Main:** Flex 1, overflow-y auto. Padding 28px 32px.
- **Header (main):** Sticky top, border-bottom, flex between title and actions.
- **Demo Banner (optional):** Sticky, amber bg, full width within main.

---

## Components

### Button

**Variants:**
- `default`: `bg-emerald-600 hover:bg-emerald-700 text-white` — Primary CTA
- `outline`: `border bg-transparent hover:bg-accent` — Secondary
- `ghost`: `hover:bg-accent hover:text-accent-foreground` — Tertiary
- `link`: `underline-offset-4 hover:underline` — Inline

**Sizes:** default (h-9), sm (h-8), lg (h-10), icon (size-9)

### Card

```
bg: #111111 (or transparent)
border: 1px solid rgba(255,255,255,0.05)
border-radius: 6px
padding: 20px
```

No shadow. Flat by design.

### Badge

- **Client badge (sidebar):** `bg: rgba(16,185,129,0.06); border: 1px solid rgba(16,185,129,0.12); border-radius: 6px; padding: 10px 12px;`
- **Status badge:** Emerald dot (6px) + label, or amber for warnings.
- **Tag badge:** `bg: rgba(255,255,255,0.05); border-radius: 4px; padding: 2px 8px; font-size: 11px;`

### Input / Search

```
background: transparent
border: 1px solid rgba(255,255,255,0.1)
border-radius: 6px
padding: 10px 14px
font-family: 'Inter', sans-serif
font-size: 13px
color: rgba(255,255,255,0.9)
placeholder: rgba(255,255,255,0.25)
focus: border-color: rgba(16,185,129,0.4)
```

### Table

```
Header: border-bottom: 1px solid rgba(255,255,255,0.05)
Header text: font-family: 'JetBrains Mono', monospace; font-size: 9px; uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.3)
Row: border-bottom: 1px solid rgba(255,255,255,0.03)
Row hover: background: rgba(255,255,255,0.02)
Cell padding: 12px 16px
Font: 13px Inter (primary), 11px JetBrains Mono (data)
```

### Search Wall (muro suave — `/buscar`)

Muro de registro para el visitante anónimo cuando hay más resultados que la
primera página. Los resultados ocultos **no se cargan**: el API
(`/api/public/search`) devuelve solo la primera página y el bloque difuminado
es un esqueleto estático sin datos.

```
Wall: position relative, overflow hidden
Skeleton: misma tabla .results-table; filter blur(5px), opacity 0.55,
  pointer-events none, aria-hidden; barras 12px radius 4px rgba(255,255,255,0.14)
Fade: linear-gradient 180deg transparent → hsl(var(--background) / 0.92)
CTA: centrado; texto 14px rgba(255,255,255,0.8); botón CTA primario
  (bg-emerald-600 hover:bg-emerald-700 text-white, JetBrains Mono)
Pagination: oculta mientras el muro está activo (solo anónimo)
```

a11y: texto ≥12px y contraste AA en texto informativo (floor white/50); el
esqueleto es decorativo (aria-hidden) y no interactivo.

### Command Palette (⌘K)

```
Overlay: rgba(0,0,0,0.6) + backdrop-blur(4px)
Modal: max-width 580px, bg: #111, border: rgba(255,255,255,0.1), radius: 12px
Input: JetBrains Mono, 14px, padding: 16px 60px 16px 20px
Results: padding 8px, hover: rgba(255,255,255,0.05)
Shortcut hints: JetBrains Mono, 11px, rgba(255,255,255,0.2)
```

### Nav Item (Sidebar)

```
padding: 8px 20px
font-size: 13px
color: rgba(255,255,255,0.4)
border-left: 2px solid transparent
transition: color 0.15s, background 0.15s
hover: color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.03)
active: color: rgba(255,255,255,0.9); border-left-color: #10b981; background: rgba(16,185,129,0.05)
```

---

## Animations

| Name | Duration | Easing | Usage |
|------|----------|--------|-------|
| `ticker` | 40s | linear infinite | Data ticker scroll (vertical) |
| `marquee` | 60s | linear infinite | Logo/partner marquee (horizontal) |
| `pulse-soft` | 3s | ease-in-out | Live counter pulse |
| `blink` | 1.2s | steps(1) | Logo underscore cursor |
| `fade-in-up` | 0.4s | ease-out | Page load stagger |
| `accordion-down` | 0.2s | ease-out | Expandable sections |

---

## Pages

### Marketing (público)

| Page | Route | Purpose |
|------|-------|---------|
| Home | `/` | Landing, hero, features, pricing, CTA |
| Cobertura | `/cobertura` | Dataset info, stats, sources |
| Blog | `/blog` | Posts list + individual posts |
| Contacto | `/contact` | Form + info |
| Pricing | `/#pricing` (home anchor) | Planes Free/Pro/Empresa |
| Sign-in | `/sign-in` | Clerk auth; soporta `?redirect=` (ruta interna) para volver tras acceder |
| Sign-up | `/sign-up` | Clerk auth; soporta `?redirect=` (ruta interna), fallback `/cuenta/onboard` |
| Perfil proveedor | `/perfil/[nif]` | Ficha pública SEO del proveedor; CTA «Seguir» (F1.2): anónimo → `/sign-up?redirect=/perfil/<nif>`, autenticado → `POST/DELETE /api/follows` (type=proveedor) |
| Buscador | `/buscar` | Búsqueda pública anónima; muro suave de registro (primera página + esqueleto difuminado + CTA) |

### App (autenticado, dashboard layout)

| Page | Route | Purpose |
|------|-------|---------|
| Dashboard | `/dashboard` | Redirect to default view |
| Monitor | `/monitor` | Alertas de licitaciones |
| Alertas | `/monitor/alertas` | Lista de alertas configuradas |
| Oportunidades | `/monitor/oportunidades` | Licitaciones filtradas |
| Oportunidad | `/monitor/oportunidad/[id]` | Detalle de licitación |
| Explorer | `/explorer` | Inteligencia competitiva |
| Renovaciones | `/explorer/renovaciones` | Predicción de renovaciones |
| Competencia | `/explorer/competencia` | Análisis de competidores |
| Mercado | `/explorer/mercado` | Volumen por sector |
| Historial | `/explorer/historial` | Búsquedas guardadas |
| Onboarding | `/explorer/onboard` | Flujo de bienvenida |

---

## Assets

### Logo

- **Favicon:** `/favicon.svg` — SVG inline, monospaced text
- **Text logo:** `elicita_` with emerald underscore + blink animation
- **No image logo** — typographic only

### Icons

- **Library:** Lucide React (`lucide-react`)
- **Size:** 12px (nav), 16px (buttons), 20px (features)
- **Color:** Inherits from text

---

## Responsive

| Breakpoint | Width | Changes |
|------------|-------|---------|
| Mobile | < 768px | Single column, hamburger nav, sidebar collapsible or hidden |
| Tablet | 768-1024px | Sidebar may collapse to icons-only |
| Desktop | > 1024px | Full layout, 220px sidebar |

---

## Accessibility

- All interactive elements have focus states (ring: `hsl(var(--ring))`)
- Color contrast meets WCAG AA for text-primary on bg-base
- Reduced motion: Respect `prefers-reduced-motion` for animations
- Semantic HTML: nav, main, aside, header, footer
- ARIA labels on icon-only buttons

---

### Follow CTA — Perfil de proveedor (`/perfil/[nif]`, F1.2)

Botón de seguimiento en la cabecera de la ficha. Renderizado servidor como
enlace (estado anónimo, cacheable); el script inline lo convierte en botón
cuando hay sesión Clerk.

**Estados:**
- Anónimo: enlace `bg-emerald-500 hover:bg-emerald-600 text-black` con icono ☆ y texto «Avísame cuando participe o gane» → `/sign-up?redirect=/perfil/<nif>`
- Autenticado, no sigue: «Seguir» (`OFF`, mismo estilo primario)
- Autenticado, siguiendo: «Dejar de seguir», icono ★, estilo `bg-emerald-500/10 text-emerald-400 border-emerald-500/30` (`aria-pressed="true"`)
- Límite Free alcanzado: mensaje inline `text-xs text-white/70` con `role="alert"` «Ya sigues otro perfil — gestiona tus seguimientos» + enlace a `/cuenta/alertas`

**Reglas:** texto mínimo 12px; contraste AA (texto negro sobre emerald-500 ≈ 7:1; emerald-400 sobre bg-base ≈ 9:1); botón `font-mono text-sm` coherente con la ficha; mensaje con `aria-live="polite"`.

### Registro mercantil · BORME — Perfil de proveedor (`/perfil/[nif]`, plan BORME 2026-10-14)

Sección de la ficha tras «Concentración» y antes de «Últimos contratos», con
la ficha registral y el timeline de actos BORME. Solo aparece si el NIF
resuelve a empresa en BORME (`nif_canonical` → `empresa_norm` por igualdad de
clave, nunca LIKE a ciegas); sin match la sección no existe (sin bloque vacío).

**Ficha registral (grid 2 col, patrón de cards existente):** Empresa,
Domicilio, Capital social (mono tabular, `toLocaleString('es-ES')`),
Constitución, Provincia, Registro (Hoja + Tomo). Labels `font-mono text-xs
text-white/30 uppercase`, valores `text-white/80 text-sm`.

**Timeline de actos (lista por boletín, fecha desc, máx 25 visibles):**
- Fecha: `font-mono text-xs text-white/50 tabular-nums sm:w-24`
- Actos de cargo: tipo (`text-white/40`) + cargo + persona conocida
  (`text-white/50`, resuelta vía `borme_personas`; los hashes históricos
  upstream sin nombre no se muestran nunca como hash)
- Otros actos (cabeceras del boletín sin cargo): `text-white/40`
- PDF del boletín: `font-mono text-[11px] text-emerald-400/70 hover:text-emerald-400`,
  target blank, title «Boletín oficial en BOE (PDF)»
- «Ver N boletines anteriores»: `<details>`/`<summary>` nativo (cero JS),
  summary `font-mono text-xs text-emerald-400/70 cursor-pointer`
- Pie: «Fuente: BORME (BOE) · resuelto por NIF → denominación registral»
  `font-mono text-[11px] text-white/25`

**Reglas:** sereno por diseño (jerarquía por opacidad, sin badges de colores);
fechas tabulares; cero JS cliente; a11y floor white/50 en texto informativo;
fechas de boletín siempre con enlace verificable al PDF oficial.

---

## Component Patterns — Elicita Specific

### Opportunity Card (Hero + Dashboard)

The signature component. Data-dense, monospaced, terminal aesthetic.

```
Container: border: 1px solid rgba(16,185,129,0.20); bg: black/60; backdrop-blur; border-radius: 8px; padding: 20px
Font: JetBrains Mono, 12px

Header row:
  Left: status label — text-[10px] uppercase tracking-widest text-emerald-400
  Right: confidence % — text-emerald-400/60 text-[10px]
  Bottom border: border-b border-white/5, mb-4 pb-3

Field rows (flex justify-between):
  Label: text-white/30, shrink-0
  Value: text-white/80 text-right (primary), text-white/60 (secondary)
  Special values: emerald-400 (dates/scores), white font-medium (amounts)
  Gap between rows: 2.5 (10px)

Score bar (bottom):
  Border-top: border-t border-white/5, mt-4 pt-3
  Label: text-white/30 text-[10px]
  Value: text-emerald-400 font-medium (e.g. "94 / 100")
  Bar: h-1 bg-white/5 rounded-full, fill: bg-emerald-500, width: N%
```

### Contract Card (Monitor Grid)

```
Container: display block; bg: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 20px; cursor: pointer
Hover: border-color → rgba(16,185,129,0.3)

Layout:
  Top: card-org (left, mono 11px, white/40, uppercase, ellipsis) + source-badge (right, mono 10px, padded)
  CPV name: 11px, emerald/40, truncated
  Objeto: 14px, white/80, line-clamp 2, min-height 2.9em
  Footer: mono 12px, white/30, flex wrap, separators white/12
```

### Filter Bar

```
Layout: flex, gap 12px, margin-top 16px, flex-wrap wrap

Filter button:
  bg: rgba(255,255,255,0.04)
  border: 1px solid rgba(255,255,255,0.08)
  border-radius: 6px
  padding: 8px 14px
  color: rgba(255,255,255,0.6)
  font-size: 13px
  hover/active: border-color → rgba(16,185,129,0.3), color → white/80
  Chevron: 10px, opacity 0.5

Dropdown:
  bg: #111
  border: 1px solid rgba(255,255,255,0.1)
  border-radius: 8px
  padding: 8px
  max-height: 300px, overflow-y auto
  min-width: 320px (full: 200px narrow)
  z-index: 20

Dropdown search:
  bg: rgba(255,255,255,0.04)
  border: 1px solid rgba(255,255,255,0.08)
  border-radius: 4px
  padding: 6px 10px
  font-size: 12px
  focus: border-color → rgba(16,185,129,0.3)

Dropdown item:
  padding: 6px 8px, border-radius: 4px, font-size: 12px
  hover: bg rgba(255,255,255,0.04)
  Active: color white/85, emerald check mark
```

### Proyección Badge

```
font-family: 'JetBrains Mono', monospace
font-size: 9px
color: rgba(245,158,11,0.7)
background: rgba(245,158,11,0.06)
border: 1px solid rgba(245,158,11,0.2)
border-radius: 4px
padding: 4px 10px
white-space: nowrap
```

### Data Ticker (Hero Background)

```
3 columns, each 1/3 width
opacity: 0.07
Cards: mono text-[10px], white/80, border-white/10 rounded, px-2 py-1.5
Animation: ticker 40s linear infinite (vertical translateY)
Layout label: estado (emerald/80) + importe right-aligned
Detail lines: org · cpv (white/50), objeto (white/30 truncated)
```

### Live Counter (Hero Stats)

```
font-family: 'JetBrains Mono', monospace
font-size: 18px (lg)
color: white
animation: pulse-soft 3s ease-in-out infinite
Counter label: text-white/30 text-[11px] mt-1
Grid: 3 cols, gap-x-6 gap-y-5, border-t border-white/5 pt-4
```

### Source Badge (Per-Source Color Coding)

Each data source gets a distinct color badge on contract cards:

| Source | Text Color | BG Color |
|--------|-----------|----------|
| Plataforma | emerald-400 | rgba(16,185,129,0.1) |
| Perfil Contratante | blue-400 | rgba(59,130,246,0.1) |
| BOE | amber-400 | rgba(245,158,11,0.1) |
| BOA | purple-400 | rgba(168,85,247,0.1) |
| BOP | cyan-400 | rgba(6,182,212,0.1) |

---

## Anti-Patterns

❌ **No usar:**
- Gradientes (excepto data ticker fades)
- Sombras en cards (flat design)
- Bordes redondeados grandes (max 12px)
- Colores pastel o brillantes
- Imágenes decorativas sin propósito
- Más de 2 fuentes
- Texto centrado en bloques largos

✅ **Siempre usar:**
- Espacio negario generoso
- Tipografía monoespaciada para datos
- Estados de hover en todo elemento interactivo
- Transiciones suaves (150-200ms)
- Emerald solo para acciones primarias y estados activos

---

## FARO — registro cívico y blog en la home (2026-09-16)

La home pública usa el **registro cívico claro** (sistema `.faro-*`): papel oklch claro, tinta verde-oliva, acento civic/emerald y ámbar para lo no-verificado. Es la excepción documentada al dark-first: la banda del Observatorio recupera el dark al cerrar la página.

**Integración del blog (header + home):**
- **Header**: nav item "Blog" (→ `/blog`), último del array `navItems` — heredado por menú móvil y palette.
- **Home**: sección "05 · Análisis: el blog de elicita_" antes de la banda oscura — 3 tarjetas FARO (`.faro-card`): destacado `oligopolio-it-publico` + 2 últimos por `data.date`, con fecha ISO (mono, sin Intl), título, excerpt y "Leer análisis →"; cierre "Ver todo el blog →".
- **Selección en build** (prerender, cero JS): `getCollection('blog')` sin drafts, orden descendente por fecha.
- El blog mantiene su identidad dark editorial (consistente con el sitio app); la franja de la home usa el registro cívico de la home.

---

## References

- **Google Stitch:** https://stitch.withgoogle.com/docs/design-md/format/
- **Awesome Design.md:** https://github.com/VoltAgent/awesome-design-md
- **shadcn/ui:** https://ui.shadcn.com
- **Tailwind CSS:** https://tailwindcss.com

---

*Última actualización: 2026-09-16*
*Aplicable a: elicita.es, sub-agentes de frontend, nuevas páginas*

## Mobile-first — tablas de datos ocultas (a11y)

Las tablas sr-only (patrón clip + position:absolute) deben llevar `table-layout: fixed` y forzar `white-space: normal; max-width: 1px; overflow: hidden` en caption/th/td: con `table-layout: auto`, el min-content de celdas/caption (nowrap) manda sobre `width: 1px` vía CAPMIN/MIN y desborda el viewport móvil (bug 07-10-2026, home). Verificado: tabla 566px→1px, scrollWidth 380==clientWidth a 390px.
