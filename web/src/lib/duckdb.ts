/**
 * DuckDB client for Elicita API
 * Reads from the unified contratos_vivos view
 * Long-lived connection for server mode
 */
import duckdb from 'duckdb';

// Allow JSON serialization of BigInt values from DuckDB
;(BigInt.prototype as any).toJSON = function() { return Number(this); };

const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
// Base de estado propia del web: tablas que ESCRIBE el web (alertas, cuotas,
// claves API, resúmenes IA, matching). Separada de la base de ingesta para que
// el web nunca compita por el lock de escritura de licitaciones.duckdb.
const WEB_STATE_PATH = process.env.DUCKDB_WEB_STATE_PATH || '/var/data/licitaciones/db/web-state.duckdb';
const OPEN_RETRIES = 4;
const OPEN_RETRY_DELAY_MS = 3000;
const STATE_RETRIES = 4;
const STATE_RETRY_DELAY_MS = 750;

// Singleton connection
let db: duckdb.Database | null = null;
let conn: duckdb.Connection | null = null;
// Promesa del SET inicial de la conexión: ninguna query puede arrancar
// antes de que complete (race del primer vuelo → muerte silenciosa del
// proceso, verificado 2026-10-12 en local y producción).
let connReady: Promise<void> = Promise.resolve();
let initPromise: Promise<void> | null = null;
let consecutiveFailures = 0;
const MAX_FAILURES = 3;
const RECONNECT_DELAY_MS = 2000;

/**
 * Health check: verifies the connection responds.
 * Returns true if healthy, false if broken.
 */
async function healthCheck(): Promise<boolean> {
  if (!conn) return false;
  return new Promise((resolve) => {
    conn!.all('SELECT 1', (err) => resolve(!err));
  });
}

/**
 * Force reconnect: closes stale connection and creates a new one.
 */
async function reconnect(): Promise<void> {
  console.log('[duckdb] Reconnecting — closing stale connection...');
  closeDuckDB();
  // Small delay to let OS release file handles
  await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
  await init();
  consecutiveFailures = 0;
  console.log('[duckdb] Reconnected successfully.');
}

export interface ContratoFilters {
  estados?: string[];
  fuentes?: string[];
  cpvs?: string[];
  importe_min?: number;
  importe_max?: number;
  organismos?: string[];
  q?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
  solo_activas?: boolean;
}

export interface Contrato {
  id: string;
  fuente: string;
  expediente: string | null;
  organismo: string;
  objeto: string;
  cpv: string;
  cpvs: string[];
  importe_num: number;
  importe: string;
  fecha_publicacion: string;
  fecha_fin: string | null;
  url: string | null;
  estado: string;
  adjudicatario: string | null;
  nif_adjudicatario: string | null;
}

function isLockError(err: any): boolean {
  return /Could not set lock|Conflicting lock/i.test(String(err?.message || err || ''));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getDb(): duckdb.Database {
  if (!db) {
    // READ-ONLY: la base de ingesta solo la escribe el materializador (con el
    // web parado). Antes el web la abría en RW y competía por el único lock de
    // escritura de DuckDB contra ingesta/auxiliares — origen de los bucles de
    // «Connection was never established». RO abre en paralelo con otros
    // lectores (connectors, matching, reportes, MCP via CLI -readonly).
    // Reintenta en frío: si arranca durante la ventana de materialización,
    // espera a que el swap libere el lock en vez de nacer roto.
    for (let attempt = 1; attempt <= OPEN_RETRIES; attempt++) {
      try {
        db = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
        db.exec("SET memory_limit = '2GB'; SET threads = 2; SET preserve_insertion_order = false;");
        break;
      } catch (err) {
        db = null;
        if (attempt === OPEN_RETRIES || !isLockError(err)) throw err;
        console.warn(`[duckdb] main RO lock ocupado (intento ${attempt}/${OPEN_RETRIES}) — reintentando: ${String((err as any)?.message || '').slice(0, 80)}`);
        // Síncrono aquí es inviable: getDb es sync. Delegamos el reintento a
        // ensureMainDb() asíncrono en query(); este try/catch solo cubre el
        // caso sin contención.
        throw err;
      }
    }
    if (!db) throw new Error('[duckdb] main RO: no se pudo abrir');
  }
  return db;
}

/**
 * Abre la base principal RO con reintentos con backoff (contención con la
 * ventana de materialización). Sustituye a getDb() en los flujos async.
 */
async function ensureMainDb(): Promise<duckdb.Database> {
  for (let attempt = 1; attempt <= OPEN_RETRIES; attempt++) {
    try {
      return getDb();
    } catch (err) {
      if (attempt === OPEN_RETRIES || !isLockError(err)) throw err;
      console.warn(`[duckdb] main RO ocupada (intento ${attempt}/${OPEN_RETRIES}) — reintentando en ${OPEN_RETRY_DELAY_MS}ms`);
      await sleep(OPEN_RETRY_DELAY_MS);
    }
  }
  throw new Error('[duckdb] main RO: reintentos agotados');
}

function getConnInternal(): duckdb.Connection {
  if (!conn) {
    conn = getDb().connect();
    connReady = new Promise<void>((resolve, reject) => {
      conn!.exec("SET memory_limit = '2GB'; SET threads = 2; SET preserve_insertion_order = false;", (err: any) => (err ? reject(err) : resolve()));
    });
  }
  return conn;
}

/**
 * Get a short-lived READ-WRITE connection to the web-state database.
 * Aux writers (ai-resumen, matching, pliegos) MUST use web-state, never the
 * main ingestion database.
 */
/**
 * Mutex en proceso para web-state (tarea 37): las conexiones por operación en
 * PARALELO sobre el mismo fichero disparan conflictos write-write del MVCC
 * optimista de DuckDB e INTERNAL errors del motor (aserción en buffered
 * appends — la misma clase que la corrupción/SIGSEGV de web-state del 13-10).
 * Serializar las operaciones en proceso elimina la clase entera: cada op
 * corre en cola; la contienda cross-proceso (ingesta/auxiliares) se cubre en
 * el open (abajo).
 *
 * Sin llamadas anidadas (verificado por grep: withWriteConnection sin callers;
 * los callers de queryWrite/queryState la invocan desde el nivel superior) —
 * el mutex no puede auto-bloquearse.
 */
let stateChain: Promise<unknown> = Promise.resolve();

export async function withStateConn<T>(
  fn: (conn: duckdb.Connection) => Promise<T>
): Promise<T> {
  const run = stateChain.then(() => runStateOp(fn));
  // La cadena sobrevive a los errores de operaciones individuales.
  stateChain = run.then(
    () => undefined,
    () => undefined
  );
  return run as Promise<T>;
}

/**
 * Instancia viva de web-state por proceso con cierre por reposo (tarea 37).
 *
 * Abrir/cerrar un Database POR OPERACIÓN dispara la carrera del instance-cache
 * del binding node: un nuevo Database creado mientras el anterior aún cierra
 * (close asíncrono interno) produce DOS instancias vivas sobre el mismo
 * fichero — los locks POSIX no conflictúan dentro del proceso — con snapshot
 * obsoleto y escrituras duplicadas. Es EXACTAMENTE la clase de la corrupción
 * de web-state del 13-10 (SIGSEGV, WAL huérfano del 01-10) y se reprodujo en
 * los tests de esta tarea (INTERNAL Error "error while applying buffered
 * appends" y consumos que veían estado viejo). Con instancia única viva, la
 * visibilidad entre operaciones está garantizada (mismo catálogo/WAL).
 *
 * El lock de fichero se libera tras STATE_IDLE_CLOSE_MS sin tráfico para que
 * los runners auxiliares (matching-runner/jev-matching, que reintentan el
 * open ~6×800ms) puedan entrar en los periodos callados.
 */
let stateDb: duckdb.Database | null = null;
let stateIdleTimer: NodeJS.Timeout | null = null;
const STATE_IDLE_CLOSE_MS = 3000;

async function ensureStateDb(): Promise<duckdb.Database> {
  if (stateIdleTimer) {
    clearTimeout(stateIdleTimer);
    stateIdleTimer = null;
  }
  if (!stateDb) {
    for (let attempt = 1; attempt <= STATE_RETRIES; attempt++) {
      try {
        stateDb = new duckdb.Database(WEB_STATE_PATH);
        break;
      } catch (err) {
        stateDb = null;
        if (attempt === STATE_RETRIES || !isLockError(err)) throw err;
        console.warn(`[duckdb] web-state lock ocupado (intento ${attempt}/${STATE_RETRIES}) — reintentando`);
        await sleep(STATE_RETRY_DELAY_MS);
      }
    }
    if (!stateDb) throw new Error('[duckdb] web-state: no se pudo abrir');
  }
  return stateDb;
}

function armStateIdleClose(): void {
  if (stateIdleTimer) clearTimeout(stateIdleTimer);
  stateIdleTimer = setTimeout(() => {
    stateIdleTimer = null;
    const db = stateDb;
    stateDb = null;
    try { db?.close(); } catch { /* noop */ }
  }, STATE_IDLE_CLOSE_MS);
  stateIdleTimer.unref?.();
}

async function runStateOp<T>(fn: (conn: duckdb.Connection) => Promise<T>): Promise<T> {
  const sdb = await ensureStateDb();
  let sconn: duckdb.Connection | null = null;
  try {
    sconn = sdb.connect();
    sconn.exec("SET memory_limit = '512MB'; SET threads = 2;");
    return await fn(sconn);
  } finally {
    try { sconn?.close(); } catch { /* noop */ }
    armStateIdleClose();
  }
}

/**
 * Row normalization shared by main and state query paths.
 */
function normalizeRows(rows: any[] | undefined): any[] {
  return (rows || []).map((r: any) => {
    const obj: any = {};
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'bigint') {
        obj[k] = Number(v);
      } else if (v instanceof Date) {
        obj[k] = v.toISOString().slice(0, 10);
      } else {
        obj[k] = v;
      }
    }
    return obj;
  });
}

/**
 * Query the WEB-STATE database (per-op RW connection + retry).
 * Para tablas que el web posee y escribe: alertas, api_keys,
 * api_usage_daily/monthly, ia_resumenes, ia_perfiles, ia_matching_results,
 * pliegos_extraidos. NUNCA para contratos_vivos ni tablas de ingesta.
 */
export async function queryState(sql: string, params: any[] = []): Promise<any[]> {
  return withStateConn(
    (sconn) =>
      new Promise<any[]>((resolve, reject) => {
        sconn.all(sql, ...params, (err: any, rows: any[]) => {
          if (err) reject(err);
          else resolve(normalizeRows(rows));
        });
      })
  );
}

function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Asegura la base principal RO (reintenta si arranca en ventana de
    // materialización) y crea el estado propio si aún no existe.
    await ensureMainDb().catch((err) => {
      console.error('[duckdb] init: main RO no disponible:', (err as any)?.message);
      throw err;
    });
    // alertas vive en web-state (antes se creaba sobre la base de ingesta).
    try {
      await queryState(`
        CREATE TABLE IF NOT EXISTS alertas (
          id VARCHAR PRIMARY KEY,
          user_id VARCHAR NOT NULL,
          email VARCHAR NOT NULL,
          nif_proveedor VARCHAR,
          cpv VARCHAR,
          organismo VARCHAR,
          created_at TIMESTAMP DEFAULT NOW(),
          last_sent_at TIMESTAMP,
          active BOOLEAN DEFAULT TRUE
        )
      `);
      await queryState('CREATE INDEX IF NOT EXISTS idx_alertas_user ON alertas(user_id)');
    } catch (err: any) {
      console.error('[duckdb] alertas init (web-state):', err?.message);
    }
  })();
  return initPromise;
}

/**
 * Normalize estado to canonical form for filtering
 */
export function normEstado(s: string): string {
  const base = s.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');
  if (base === 'publicado') return 'publicada';
  if (base === 'adjudicado') return 'adjudicada';
  if (base === 'resuelto') return 'resuelta';
  if (base === 'formalizado') return 'formalizada';
  if (base === 'anuncio_previo' || base === 'anuncio previo' || base === 'previa') return 'anuncio_previo';
  if (base === 'evaluacion') return 'evaluacion';
  if (base === 'en_curso') return 'en_curso';
  return base;
}

/**
 * Normalize fuente for filtering
 */
export function normFuente(s: string): string {
  return (s || '').toUpperCase().replace(/_/g, ' ').trim();
}

/**
 * Build SQL WHERE clause and params from filters
 */
function buildWhereClause(filters: ContratoFilters): { clause: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];

  // Estados filter
  if (filters.estados && filters.estados.length > 0) {
    const estados = filters.estados.map(normEstado);
    const placeholders = estados.map(() => '?').join(',');
    conditions.push(`LOWER(estado) IN (${placeholders})`);
    params.push(...estados);
  }

  // Fuentes filter
  if (filters.fuentes && filters.fuentes.length > 0) {
    const fuentes = filters.fuentes.map(normFuente);
    const placeholders = fuentes.map(() => '?').join(',');
    conditions.push(`UPPER(REPLACE(fuente, '_', ' ')) IN (${placeholders})`);
    params.push(...fuentes);
  }

  // CPV prefix filter
  if (filters.cpvs && filters.cpvs.length > 0) {
    const prefixes = filters.cpvs.map(p => p.replace('.0', '').trim().slice(0, 5));
    const placeholders = prefixes.map(() => '?').join(',');
    conditions.push(`SUBSTRING(REPLACE(REPLACE(cpv, '.0', ''), ' ', ''), 1, 5) IN (${placeholders})`);
    params.push(...prefixes);
  }

  // Importe range (validated — reject negative/NaN)
  if (filters.solo_activas) {
    conditions.push('importe_licitacion > 0');
  }
  const impMin = Number(filters.importe_min);
  if (!isNaN(impMin) && impMin > 0) {
    conditions.push('importe_licitacion >= ?');
    params.push(impMin);
  }
  const impMax = Number(filters.importe_max);
  if (!isNaN(impMax) && impMax > 0) {
    conditions.push('importe_licitacion <= ?');
    params.push(impMax);
  }

  // Fecha activas: excluir ofertas ya finalizadas y fechas inválidas.
  if (filters.solo_activas) {
    conditions.push(`(fecha_fin IS NULL OR fecha_fin >= CURRENT_DATE)
      AND (fecha_publicacion IS NOT NULL AND fecha_publicacion >= DATE '2024-01-01')`);
  }
  if (filters.organismos && filters.organismos.length > 0) {
    const orgConditions = filters.organismos.map(() => 'LOWER(organismo) LIKE ?');
    conditions.push(`(${orgConditions.join(' OR ')})`);
    params.push(...filters.organismos.map(o => `%${o.toLowerCase()}%`));
  }

  // Text search with multi-term (OR — any term matches in objeto or organismo)
  if (filters.q) {
    const terms = filters.q.split(/\s+/).filter(t => t.length > 1);
    if (terms.length > 0) {
      const termConditions = terms.map(term => {
        params.push(`%${term}%`, `%${term}%`);
        return '(LOWER(objeto) LIKE ? OR LOWER(organismo) LIKE ?)';
      });
      conditions.push(`(${termConditions.join(' OR ')})`);
    }
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Build ORDER BY clause
 */
function buildOrderBy(sort: string, dir: 'asc' | 'desc'): string {
  const direction = dir === 'asc' ? 'ASC' : 'DESC';
  switch (sort) {
    case 'importe':
      return `ORDER BY importe_licitacion ${direction} NULLS LAST, id ${direction}`;
    case 'objeto':
      return `ORDER BY objeto ${direction} NULLS LAST, id ${direction}`;
    case 'organismo':
      return `ORDER BY organismo ${direction} NULLS LAST, id ${direction}`;
    case 'adjudicatario':
      return `ORDER BY adjudicatario ${direction} NULLS LAST, id ${direction}`;
    case 'relevance':
      // Relevance sort is done post-query by scoring matches
      return ''; // Will be sorted in JS after fetch
    case 'fecha':
    default:
      return `ORDER BY (CASE WHEN fecha_publicacion IS NULL OR fecha_publicacion < DATE '2010-01-01' THEN 1 ELSE 0 END), fecha_publicacion ${direction} NULLS LAST, id ${direction}`;
  }
}

/**
 * Format importe for display
 */
function formatImporte(val: number | null): string {
  if (val == null || val === 0) return '—';
  if (val >= 1000000) return `€ ${(val / 1000000).toFixed(2)}M`;
  if (val >= 1000) return `€ ${(val / 1000).toFixed(0)}K`;
  return `€ ${val.toFixed(2)}`;
}

/**
 * Execute a query and return rows.
 * Auto-recovers from stale connections via health check + reconnect.
 */
function isConnectionError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return /Connection Error|never established|closed already/i.test(msg);
}

async function runQueryInternal(sql: string, params: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    getConnInternal().all(sql, ...params, (err, rows) => {
      if (err) {
        // Connection may be stale — trigger async reconnect for next call
        if (consecutiveFailures < MAX_FAILURES) {
          consecutiveFailures++;
          console.warn(`[duckdb] Query failed (${consecutiveFailures}/${MAX_FAILURES}): ${err.message?.slice(0, 100)}`);
        }
        reject(err);
        return;
      }
      consecutiveFailures = 0;
      resolve(normalizeRows(rows));
    });
  });
}

/**
 * Cola de serialización de la conexión singleton.
 * El binding duckdb-node NO soporta queries solapadas sobre la misma
 * Connection: dos conn.all() concurrentes (p. ej. el Promise.all de
 * count+rows en api/public/search) compiten por la conexión nativa y el
 * proceso muere con SIGSEGV sin log (verificado 2026-10-12: 3/3 en
 * producción, repro local con 3 búsquedas concurrentes). Toda query —
 * incluido el healthCheck, que también usa la conexión — pasa por esta cola.
 */
let queryQueue: Promise<unknown> = Promise.resolve();

function enqueueQuery<T>(fn: () => Promise<T>): Promise<T> {
  const run = queryQueue.then(fn, fn);
  queryQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function runQuery(sql: string, params: any[]): Promise<any[]> {
  return enqueueQuery(async () => {
    // El SET inicial debe haber completado antes de CUALQUIER query: lanzarlo
    // en vuelo sobre la conexión recién nacida y solapar la primera query
    // mata el binding nativo (race del primer vuelo, 2026-10-12).
    await connReady;
    // Health check + query bajo la misma exclusión: ambos usan la conexión.
    if (conn && !(await healthCheck())) {
      console.warn('[duckdb] Health check failed — reconectando antes de consultar...');
      await reconnect();
    }
    try {
      return await runQueryInternal(sql, params);
    } catch (err) {
      if (!isConnectionError(err) && !isLockError(err)) throw err;
      console.warn(`[duckdb] Conexión rota o lock ocupado — reconectando y reintentando: ${String((err as any)?.message || '').slice(0, 100)}`);
      await reconnect();
      return runQueryInternal(sql, params);
    }
  });
}

export async function query(sql: string, params: any[] = []): Promise<any[]> {
  // Garantiza base principal abierta (con reintentos si hay contención de
  // lock en arranque frío). La ejecución real va serializada por enqueueQuery.
  if (!db) {
    await ensureMainDb();
    if (!conn) getConnInternal();
  }
  return runQuery(sql, params);
}

/**
 * Alias semántico para consultas de solo lectura desde endpoints admin.
 * La protección real del endpoint (duckdb-query) está en su validación
 * estricta (SELECT/WITH + forbidden + un solo statement) + IP allowlist + secret.
 * Se mantiene una única conexión RW del proceso para evitar lock de archivo
 * con la singleton del servidor web.
 */
export const queryReadOnly = query;

/**
 * Get total count with filters
 */
export async function getTotal(filters: ContratoFilters): Promise<number> {
  await init();
  const { clause, params } = buildWhereClause(filters);
  const sql = `SELECT COUNT(*) as total FROM contratos_vivos ${clause}`;
  const rows = await query(sql, params);
  return rows[0]?.total || 0;
}

/**
 * Get contratos with filters, sort, pagination
 */
export async function queryContratos(filters: ContratoFilters): Promise<{
  contratos: Contrato[];
  total: number;
}> {
  await init();

  const { clause, params } = buildWhereClause(filters);
  const orderBy = buildOrderBy(filters.sort || 'fecha', filters.dir || 'desc');
  const limit = Math.min(filters.limit || 200, 500);
  const page = Math.max(1, filters.page || 1);
  const offset = (page - 1) * limit;

  // Get total
  const countSql = `SELECT COUNT(*) as total FROM contratos_vivos ${clause}`;
  const countRows = await query(countSql, params);
  const total = countRows[0]?.total || 0;

  // Get data
  const sql = `
    SELECT
      id,
      fuente,
      expediente,
      organismo,
      objeto,
      cpv,
      cpvs,
      importe_licitacion,
      importe_adjudicacion,
      fecha_publicacion,
      fecha_fin,
      url,
      estado,
      adjudicatario,
      nif_adjudicatario
    FROM contratos_vivos
    ${clause}
    ${orderBy}
    LIMIT ? OFFSET ?
  `;

  // When sorting by relevance, we need ALL matching results (no limit/offset)
  // to score and sort them in JS
  const needsRelevanceScoring = filters.sort === 'relevance' && filters.q;

  const effectiveLimit = needsRelevanceScoring ? 2000 : limit;
  const effectiveOffset = needsRelevanceScoring ? 0 : offset;

  const rows = await query(sql, [...params, effectiveLimit, effectiveOffset]);

  const contratos: Contrato[] = rows.map((r: any) => ({
    id: r.id || '',
    fuente: r.fuente || 'Desconocido',
    expediente: r.expediente || null,
    organismo: r.organismo || 'Organismo no especificado',
    objeto: r.objeto || 'Sin título',
    cpv: r.cpv || '—',
    cpvs: r.cpvs || [],
    importe_num: r.importe_licitacion || 0,
    importe: formatImporte(r.importe_licitacion),
    fecha_publicacion: r.fecha_publicacion && r.fecha_publicacion instanceof Date
      ? r.fecha_publicacion.toISOString().slice(0, 10)
      : String(r.fecha_publicacion || '').slice(0, 10),
    fecha_fin: r.fecha_fin && r.fecha_fin instanceof Date
      ? r.fecha_fin.toISOString().slice(0, 10)
      : (r.fecha_fin ? String(r.fecha_fin).slice(0, 10) : null),
    url: r.url || null,
    estado: r.estado || 'abierta',
    adjudicatario: r.adjudicatario || null,
    nif_adjudicatario: r.nif_adjudicatario || null,
  }));

  // Post-query relevance scoring
  if (needsRelevanceScoring) {
    const terms = (filters.q || '').split(/\s+/).filter(t => t.length > 1);
    for (const c of contratos) {
      const objetoLow = (c.objeto || '').toLowerCase();
      const orgLow = (c.organismo || '').toLowerCase();
      let score = 0;
      for (const term of terms) {
        // Object matches (weight 3)
        const objMatches = (objetoLow.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
        score += objMatches * 3;
        // Organismo matches (weight 2)
        const orgMatches = (orgLow.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
        score += orgMatches * 2;
        // Exact phrase bonus in objeto
        if (objetoLow.includes(filters.q!)) score += 10;
        // Exact phrase bonus in organismo
        if (orgLow.includes(filters.q!)) score += 5;
      }
      (c as any)._relevance = score;
    }
    contratos.sort((a, b) => ((b as any)._relevance || 0) - ((a as any)._relevance || 0));
    // Apply pagination after sorting
    const sliced = contratos.slice(offset, offset + limit);
    return { contratos: sliced, total };
  }

  return { contratos, total };
}

/**
 * Get a single contrato by ID
 */
export async function getContratoById(id: string): Promise<Contrato | null> {
  await init();
  const sql = `
    SELECT
      id,
      fuente,
      expediente,
      organismo,
      objeto,
      cpv,
      cpvs,
      importe_licitacion,
      importe_adjudicacion,
      fecha_publicacion,
      fecha_fin,
      url,
      estado,
      adjudicatario,
      nif_adjudicatario
    FROM contratos_vivos
    WHERE id = ?
    LIMIT 1
  `;
  const rows = await query(sql, [id]);
  if (!rows.length) return null;

  const r = rows[0];
  return {
    id: r.id || '',
    fuente: r.fuente || 'Desconocido',
    expediente: r.expediente || null,
    organismo: r.organismo || 'Organismo no especificado',
    objeto: r.objeto || 'Sin título',
    cpv: r.cpv || '—',
    cpvs: r.cpvs || [],
    importe_num: r.importe_licitacion || 0,
    importe: formatImporte(r.importe_licitacion),
    fecha_publicacion: r.fecha_publicacion && r.fecha_publicacion instanceof Date
      ? r.fecha_publicacion.toISOString().slice(0, 10)
      : String(r.fecha_publicacion || '').slice(0, 10),
    fecha_fin: r.fecha_fin && r.fecha_fin instanceof Date
      ? r.fecha_fin.toISOString().slice(0, 10)
      : (r.fecha_fin ? String(r.fecha_fin).slice(0, 10) : null),
    url: r.url || null,
    estado: r.estado || 'abierta',
    adjudicatario: r.adjudicatario || null,
    nif_adjudicatario: r.nif_adjudicatario || null,
  };
}

/**
 * Get distinct fuentes from the view
 */
export async function getFuentes(): Promise<string[]> {
  await init();
  const sql = `SELECT DISTINCT fuente FROM contratos_vivos WHERE fuente IS NOT NULL ORDER BY fuente`;
  const rows = await query(sql, []);
  return rows.map((r: any) => r.fuente);
}

/**
 * Close connection (for graceful shutdown)
 */
export function closeDuckDB(): void {
  if (conn) {
    conn.close();
    conn = null;
  }
  if (db) {
    db.close();
    db = null;
  }
  initPromise = null;
}
