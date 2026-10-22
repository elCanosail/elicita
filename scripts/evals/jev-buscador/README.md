# Evals — buscador (JEV re-ranking)

Artefactos del spike JEV × buscador (2026-09-20), migrados desde `.tmp/` a
ubicación durable. Contexto y veredicto: `docs/plans/track-jev-buscador-spike.md`.

## Contenido

- `jev-matrix.mjs` + `RESULTADO-CONDICIONAMIENTO.md` — test de condicionamiento
  (matriz 2 consultas × 6 candidatos). Regla de diseño que sale de aquí:
  **re-ranking relativo dentro del lote, nunca gate absoluto**.
- `eval.mjs` + `eval.json` + `eval-results.json` — primer eval con pares
  consulta→target (contratos BOE). Los targets no están en el índice de
  búsqueda (hallazgo 4 del spike): todos los ranks son -1. Conservado como
  referencia; no usar para métricas.
- `eval-v3.mjs` + `eval-v3-results.json` — pool laxo (unión de búsquedas por
  palabra) + JEV re-rank sobre 5 consultas naturales. Media 456 ms/consulta,
  ~$0,0002. Base de la decisión de integrar el re-ranking.
- `fetch-pools.mjs` / `pools.json` / `cands.json` — construcción de pools.

## Integración en producción

Re-ranking integrado en `/api/public/search` detrás de doble gate:
`?smart=1` en la petición **y** `ELICITA_JEV_SMART=1` + `ELICITA_TYPESAFE_API_KEY`
en el servidor. Fail-open: cualquier error mantiene el orden tokenizado clásico.
Código: `web/src/lib/jev-rerank.ts` (reglas de diseño documentadas ahí).

## Ejecutar

Requieren el servidor local (PM2 `elicita`) y `/root/.typesafe_api_key`:

```bash
node scripts/evals/jev-buscador/eval-v3.mjs
```
