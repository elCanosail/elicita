# DESIGN.md — Elicita

> Sistema de diseño. Toda decisión visual pasa por aquí.
> Referencia: xAI console (console.x.ai) — estética técnica, dark-canvas, monospace-driven.

## Filosofía

Elicita es infraestructura de inteligencia. No es un SaaS bonito — es una consola de datos.
El diseño comunica credibilidad técnica: dark canvas, tipografía mecánica, bordes hairline,
cero sombras. La información es la protagonista; la UI desaparece.

**Principios:**
1. **Dark-canvas only.** Un solo negro. Sin modo claro en el producto.
2. **Monospace como voz de marca.** JetBrains Mono para datos, métricas, labels.
3. **Weight 400 siempre.** La jerarquía viene del tamaño y el tracking, nunca del peso.
4. **Hairline es la única elevación.** Sin sombras. Sin gradientes (salvo atmosféricos).
5. **Una forma interactiva.** Pill (9999px) para todo botón/CTA.
6. **El dato manda.** Si un elemento no sirve al dato, no existe.

## Tipografía

### Familias
| Uso | Familia | Pesos |
|-----|--------|-------|
| Sans (body, headings) | Instrument Sans | 400, 500 |
| Mono (datos, labels, eyebrows, botones) | JetBrains Mono | 400, 500 |

### Filosofía tipográfica
- **Mono es la voz de marca.** Labels en uppercase + tracking positivo. Datos numéricos siempre mono.
- **Sans para lectura.** Body, párrafos, descripciones.
- **Sin bold.** Jerarquía por tamaño y tracking, no por peso.

### Escala
| Token | Tamaño | Tracking | Uso |
|-------|--------|---------|-----|
| `text-xs` | 12px | +0.1em (mono) | Labels, badges, metadata técnica |
| `text-sm` | 14px | normal | Body secundario, tabla, formularios |
| `text-base` | 16px | -0.01em | Body principal |
| `text-lg` | 18px | -0.01em | Subheadings, cards |
| `text-xl` | 20px | -0.02em | Section titles |
| `text-2xl` | 24px | -0.02em | Page titles |
| `text-3xl` | 30px | -0.03em | Hero secundario |
| `text-4xl` | 36px | -0.03em | Hero |
| `text-5xl` | 48px | -0.04em | Display (números grandes) |

### Eyebrows (labels técnicos)
```tsx
<span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
  SECCIÓN
</span>
```
Siempre mono, uppercase, tracking +0.1em. Es la firma visual.

## Color

### Principio
Todo color pasa por CSS variables HSL en `global.css`. Prohibido hardcoded hex.

### Tokens — Dark canvas (único modo)
| Token | HSL | Hex aprox | Uso |
|-------|-----|-----------|-----|
| `--background` | 155 5% 5% | #0b0c0d | Canvas de página — el único fondo |
| `--foreground` | 155 5% 96% | #f4f5f5 | Texto principal |
| `--card` | 155 5% 8% | #121314 | Superficies (cards, panels) |
| `--card-foreground` | 155 5% 96% | #f4f5f5 | Texto en cards |
| `--popover` | 155 5% 10% | #18191a | Popovers, dropdowns |
| `--popover-foreground` | 155 5% 96% | #f4f5f5 | Texto en popovers |
| `--primary` | 152 60% 40% | #29a773 | Acciones primarias, links activos |
| `--primary-foreground` | 0 0% 5% | #0b0c0d | Texto sobre primary |
| `--secondary` | 155 5% 14% | #222324 | Botones secundarios, backgrounds sutiles |
| `--secondary-foreground` | 155 5% 65% | #a8a9a9 | Texto sobre secondary |
| `--muted` | 155 5% 14% | #222324 | Backgrounds sutiles |
| `--muted-foreground` | 155 5% 55% | #8a8b8b | Texto secundario, placeholders |
| `--destructive` | 0 62.8% 50% | #d04848 | Errores, eliminar |
| `--success` | 152 60% 40% | #29a773 | Éxito, confirmaciones |
| `--warning` | 38 92% 55% | #f0a830 | Alertas, avisos |
| `--info` | 213 94% 70% | #6ba8f0 | Información |
| `--border` | 155 5% 18% | #2a2b2c | Hairline borders — la única elevación |
| `--input` | 155 5% 18% | #2a2b2c | Input borders |
| `--ring` | 152 60% 40% | #29a773 | Focus rings |
| `--radius` | 0.5rem | — | Radio de esquinas |

### Acento de marca
Verde Elicita: `152 60% 40%` (dark). Es el único color cromático recurrente.
Usar con moderación — el verde es puntuación, no decoración.

### Reglas
```tsx
// ✅ Correcto
<div className="bg-card border border-border rounded-lg">
<span className="text-muted-foreground font-mono text-xs uppercase tracking-wider">

// ❌ Prohibido
<div style={{ backgroundColor: '#10b981' }}>
<span className="text-emerald-500">
<div className="shadow-md">
```

## Espaciado

### Escala — 4px base
| Token | Valor | Uso |
|-------|-------|-----|
| `1` | 4px | Gaps mínimos, iconos inline |
| `2` | 8px | Padding interno compacto, gaps entre badges |
| `3` | 12px | Padding de botones, inputs |
| `4` | 16px | Padding de cards, gaps entre elementos |
| `6` | 24px | Padding de secciones, gaps entre cards |
| `8` | 32px | Padding de sections, gaps entre bloques |
| `12` | 48px | Separación entre secciones |
| `16` | 64px | Hero padding vertical |
| `24` | 96px | Separación entre hero y resto |

### Reglas
- **Componentes:** 1, 2, 3, 4 (denso)
- **Sections:** 6, 8, 12 (respiración)
- **Hero:** 16, 24 (impacto)
- Móvil: reducir un step

## Radios

| Token | Valor | Uso |
|-------|-------|-----|
| `rounded-sm` | 2px | Inputs, badges |
| `rounded-md` | 4px | Cards, panels |
| `rounded-lg` | 8px | Modales, hero cards |
| `rounded-full` | 9999px | Pills (botones, CTAs, tags) |

**Pill es la forma interactiva.** Todo botón, CTA, tag = `rounded-full`.

## Elevación

**Sin sombras.** La elevación es exclusivamente hairline.

| Nivel | Cómo | Uso |
|-------|------|-----|
| Flat | Sin borde | Secciones full-bleed |
| Hairline | `border border-border` | Cards, inputs, dividers |
| Active | `border-primary` | Focus, hover, selected |

## Componentes base

### Botones — siempre pills
```tsx
// Primario (filled pill)
<button className="px-4 py-2 rounded-full bg-primary text-primary-foreground font-mono text-sm uppercase tracking-wider hover:opacity-90 transition-opacity">

// Secundario (outline pill)
<button className="px-4 py-2 rounded-full border border-border text-foreground font-mono text-sm uppercase tracking-wider hover:border-primary transition-colors">

// Ghost
<button className="px-4 py-2 rounded-full text-muted-foreground font-mono text-sm uppercase tracking-wider hover:text-foreground transition-colors">
```

### Cards
```tsx
<div className="rounded-lg border border-border bg-card p-4">
```

### Inputs
```tsx
<input className="w-full rounded-sm border border-input bg-background px-3 py-2 text-sm font-mono
  focus:ring-1 focus:ring-ring focus:outline-none" />
```

### Eyebrow (label técnico)
```tsx
<span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
  MÉTRICAS
</span>
```

### Badges — siempre pills
```tsx
// Default
<span className="inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-xs font-mono">

// Active
<span className="inline-flex items-center rounded-full border border-primary px-2.5 py-0.5 text-xs font-mono text-primary">
```

### Tabla de datos
```tsx
<table className="w-full">
  <thead>
    <tr className="border-b border-border">
      <th className="text-left font-mono text-xs uppercase tracking-wider text-muted-foreground py-2 px-3">
        EXPEDIENTE
      </th>
    </tr>
  </thead>
  <tbody>
    <tr className="border-b border-border/50 hover:bg-card transition-colors">
      <td className="py-2 px-3 font-mono text-sm">SV220414</td>
    </tr>
  </tbody>
</table>
```

## Formato de datos

### Importes — formato español
| Rango | Formato | Ejemplo |
|-------|---------|---------|
| < 1.000€ | Euro sin decimales | `890 €` |
| 1.000 - 999.999€ | Miles con punto | `45.890 €` |
| 1M - 999M€ | Millones con coma | `2,3 M€` |
| ≥ 1.000M€ | Miles de millones | `1.450 M€` |

Helper: `fmtVol()` / `fmtVolumen()` en `src/lib/format.ts`.

### Fechas
| Modo | Formato | Ejemplo |
|------|---------|---------|
| corto | `15 ene 2023` | Tablas, lists |
| largo | `15 de enero de 2023` | Display |
| iso | `2023-01-15` | Sorting, data |

Helper: `fmtDate()` en `src/lib/format.ts`.

### Datos numéricos
Siempre `font-mono`. Alineación derecha en tablas. Tracking normal.

## Motion

### Transiciones
| Token | Duración | Easing | Uso |
|-------|----------|--------|-----|
| fast | 150ms | ease-out | Hover, focus, color |
| normal | 200ms | ease-out | Expand/collapse, opacity |
| slow | 400ms | ease-in-out | Page transitions, modals |

### Animaciones
- `animate-fade-in-up` — entrada de elementos (0.6s)
- `animate-pulse-soft` — indicador "live" (3s)
- `animate-ticker` — scroll vertical de datos (40s)

Sin Framer Motion para efectos decorativos. Solo para interacciones complejas.

## Dark mode

- **Producto:** Dark only. `.dark` forzado en `<html>`.
- **Landing:** Toggle guardado en `localStorage('elicita-theme')`, default dark.
- Sin modo claro en dashboard/explorer. La consola es dark.

## Responsive

- **Mobile-first.** Base sin breakpoint = móvil.
- **Breakpoints:** `sm` (640), `md` (768), `lg` (1024), `xl` (1280)
- **Container:** max 1400px, padding 2rem
- **Tablas:** scroll horizontal en móvil
- **Sidebar:** colapsa a overlay en < 1024px

## Iconografía

Lucide React. 16px por defecto. Funcional, nunca decorativo.

## Lo que NO se hace

- ❌ Hardcoded hex — siempre `hsl(var(--token))`
- ❌ Inline `style={{}}` con px — Tailwind classes
- ❌ `font-bold` o `font-semibold` — peso 400 siempre, jerarquía por tamaño
- ❌ Sombras (`shadow-*`) — hairline borders only
- ❌ Gradientes decorativos — solo atmosféricos (footer/hero)
- ❌ `font-family` inline — `font-sans` / `font-mono`
- ❌ Breakpoints personalizados
- ❌ z-index mágicos — `z-10` → `z-50`
- ❌ Esquinas redondeadas en cards (max `rounded-lg`)
- ❌ Color como decoración — el verde es funcional

## Estructura

```
src/
├── styles/global.css        ← Tokens HSL + utilidades
├── layouts/
│   ├── main.astro            ← Landing, blog, docs
│   ├── dashboard.astro       ← Explorer (protegido)
│   ├── auth.astro            ← Sign in / sign up
│   └── blog-post.astro       ← Artículos
├── components/
│   ├── ui/                   ← Primitivas
│   ├── explorer/             ← Dashboard
│   ├── Header.tsx
│   └── Footer.tsx
├── pages/
│   ├── index.astro            ← Home
│   ├── buscar.astro           ← Buscador
│   ├── explorer/              ← Dashboard
│   └── ...
└── lib/
    ├── format.ts              ← fmtVol, fmtDate, titleCase
    ├── pricing.ts             ← Planes (single source)
    └── ...
```

## Pendiente

- [x] DESIGN.md creado
- [x] `fmtVol()` / `fmtDate()` helpers
- [ ] Refactor home (1332 → ~300 LOC + componentes)
- [ ] Refactor universo (1794 → ~400 LOC + componentes)
- [ ] Migrar botones a pills (rounded-full)
- [ ] Migrar eyebrows a mono uppercase tracking-wider
- [ ] Quitar sombras (`shadow-*`) → hairline borders
- [ ] Footer alineado con header
- [ ] Microinteracciones estandarizadas