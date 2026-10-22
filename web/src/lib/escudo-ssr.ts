/**
 * Escudo de origen para las rutas SSR HTML de datos (tarea 40).
 *
 * Las instancias viven aquí — scope de módulo = singleton por proceso. El
 * frontmatter de una página .astro corre por petición: instanciar allí sería
 * una caché nueva (vacía) en cada petición.
 *
 * El render sigue siendo por petición: se cachean DATOS (filas/agregados),
 * no HTML. Las fns que lanzan (fallo DuckDB) propagan y no se cachean.
 * El rate limit de ficha y perfil vive en cada página (rateLimitGuard
 * 120/min por IP, patrón de la tarea 29).
 */
import { createMemoCache } from './cache';

/** Ficha /licitacion/[fuente]/[id]: fila por `FUENTE|id` — espacio de claves ~618K. */
export const fichaCache = createMemoCache(10_000);
export const FICHA_TTL_MS = 600_000;

/** Perfil /perfil/[nif]: payload de agregados (5 queries) por NIF normalizado. */
export const perfilCache = createMemoCache(500);
export const PERFIL_TTL_MS = 300_000;

/** /licitaciones/[ccaa]: listado getDatos() por slug — espacio de claves cerrado (17 CCAA). */
export const licitacionesCcaaCache = createMemoCache(32);
export const CCAA_TTL_MS = 300_000;
