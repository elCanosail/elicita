/**
 * DuckDB write-mode helpers for Elicita — WEB-STATE database.
 *
 * Diseño (2026-09-22): la base de ingesta (licitaciones.duckdb) se abre en
 * READ-ONLY por el web; TODO lo que el web escribe (alertas, api_usage_*,
 * api_keys, ia_resumenes, ia_perfiles, ia_matching_results, pliegos_extraidos)
 * vive en web-state.duckdb y se accede por conexión corta por operación con
 * reintentos (ver duckdb.ts). Los procesos auxiliares (ai-resumen, matching,
 * pliegos) también escriben ahí — nunca sobre la base de ingesta.
 */
import { queryState, withStateConn } from './duckdb';

/**
 * Run a statement/query against the web-state database.
 * Same promise signature as before — callers don't need callbacks.
 */
export function queryWrite(sql: string, params: any[] = []): Promise<any[]> {
  return queryState(sql, params);
}

/**
 * Multi-statement transactional helper on the web-state database.
 * fn receives a short-lived RW connection; all statements run inside one
 * open/close cycle with lock retries.
 */
export function withWriteConnection<T>(
  fn: (conn: import('duckdb').Connection) => Promise<T>
): Promise<T> {
  return withStateConn(fn);
}

/**
 * No-op for backwards compatibility — state connections are per-operation now.
 */
export function closeWriteConnection(): void {
  /* las conexiones de web-state son por operación; nada que cerrar */
}
