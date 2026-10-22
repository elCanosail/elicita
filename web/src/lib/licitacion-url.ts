/**
 * URLs de las fichas /licitacion/[fuente]/[id] — decodificación y normalización.
 *
 * Contexto (tarea 38, sondeos con contenido 2026-10-14, preview 4395/4396):
 * Astro NO decodifica los params de ruta — `Astro.params.id` llega tal cual
 * el path. Antes de esta política la ficha consultaba la BD con el valor crudo:
 *   - `/licitacion/ANDALUCIA/AND:938655`      → 200 con contenido (RAW pasaba)
 *   - `/licitacion/ANDALUCIA/AND%3A938655`    → «no encontrada» con HTTP 200 (soft-404)
 *   - `/licitacion/EUSKADI/EUS:K-12/2020`     → 404 de ruta (3 segmentos)
 *   - `/licitacion/EUSKADI/EUS%3AK-12%2F2020` → «no encontrada» con HTTP 200 (soft-404)
 *
 * Política única del repo (tarea 39), espejada en web/scripts/sitemap-licitaciones.mjs
 * (no puede importar TS en el build de node — mantener las dos en paralelo):
 *   1. La ficha decodifica SIEMPRE `fuente` e `id` con decodificarParam() antes
 *      de consultar la BD → las formas RAW y encoded de un mismo contrato
 *      resuelven la misma fila; el encoding malformado no consulta.
 *   2. La forma NORMALIZADA (la que emiten sitemap, canonical y enlaces
 *      internos) es RAW cuando fuente/id son URL-safe (viajan idénticos por el
 *      path) y encodeURIComponent en el resto.
 *   3. No-encontrada (id inexistente o encoding malformado) responde 404 real.
 *
 * Módulo puro y client-safe: sin imports de Node, importable también desde
 * scripts de cliente (p. ej. cuenta/perfil-ia.astro).
 */

// Caracteres que viajan RAW por el path y llegan idénticos a Astro.params
// (id === encodeURIComponent(id) salvo ':' — sondeo 2026-10-14). DEBE seguir
// la misma definición que SAFE_ID/SAFE_FUENTE en web/scripts/sitemap-licitaciones.mjs.
const SAFE_ID = /^[A-Za-z0-9._!~*'():-]+$/;
const SAFE_FUENTE = /^[A-Za-z0-9._!~*'()-]+$/;

/**
 * Decodifica un segmento de ruta (Astro.params llega sin decodificar).
 * Devuelve null en encoding malformado (p. ej. '%' suelto) — un valor que el
 * path no puede representar de forma ambigua no debe llegar a la BD.
 */
export function decodificarParam(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Forma normalizada del path de una ficha: RAW si fuente e id son URL-safe
 * (identidad — sin churn en las URLs ya publicadas), encoded en el resto.
 * Devuelve el PATH (sin origen); sitemap y canonical le anteponen el dominio.
 */
export function urlFichaNormalizada(fuente: string, id: string): string {
  if (SAFE_FUENTE.test(fuente) && SAFE_ID.test(id)) {
    return `/licitacion/${fuente}/${id}`;
  }
  return `/licitacion/${encodeURIComponent(fuente)}/${encodeURIComponent(id)}`;
}

/**
 * Forma normalizada del path de un perfil /perfil/[nif] (tarea 42): misma
 * política que la ficha — RAW cuando el NIF es URL-safe (identidad, sin churn
 * en las URLs ya enlazadas), encodeURIComponent en el resto. La página de
 * perfil DECODIFICA el param (mismo patrón que la ficha, tarea 39) y
 * normaliza con trim+toUpperCase antes de consultar: la forma encoded de un
 * NIF con espacios o barras resuelve la misma fila.
 * Espejada en web/scripts/sitemap-perfiles.mjs (no importable desde .mjs).
 */
export function urlPerfilNormalizada(nif: string): string {
  if (SAFE_ID.test(nif)) {
    return `/perfil/${nif}`;
  }
  return `/perfil/${encodeURIComponent(nif)}`;
}
