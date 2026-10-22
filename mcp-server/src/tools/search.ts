import { z } from 'zod';
import { fetchElicitaTiming } from '../lib/api-client.js';
import type { ElicitaApiConfig, SearchParams, ToolResult } from '../lib/types.js';
import type { ToolRegistry } from '../lib/tool-registry.js';

const inputSchema = z.object({
  q: z.string().optional().describe('Texto libre de búsqueda (título, descripción, palabras clave).'),
  cpv: z.string().optional().describe('Código CPV o prefijo (p. ej. "30120000" o "301").'),
  importe_min: z.number().nonnegative().optional().describe('Importe mínimo en euros (sin IVA).'),
  importe_max: z.number().nonnegative().optional().describe('Importe máximo en euros (sin IVA).'),
  estado: z.string().optional().describe('Estado del procedimiento (p. ej. "Publicado", "Adjudicado", "Finalizado").'),
  fuente: z.string().optional().describe('Identificador de fuente (BOE, PLACSP, licitaciones, etc.).'),
  nif: z.string().optional().describe('NIF del organismo o empresa a buscar.'),
  fecha_desde: z.string().regex(/^20\d{2}$/).optional().describe('Año de publicación desde (YYYY, p. ej. 2024).'),
  fecha_hasta: z.string().regex(/^20\d{2}$/).optional().describe('Año de publicación hasta (YYYY, p. ej. 2026).'),
  limit: z.number().int().min(1).max(100).default(20).describe('Máximo de resultados (1-100).'),
  offset: z.number().int().min(0).default(0).describe('Desplazamiento para paginación.'),
  sort: z.string().optional().describe('Campo de ordenación: titulo, organismo, adjudicatario, importe, fuente o fecha. Legado "campo:dir" no soportado.'),
  dir: z.enum(['asc', 'desc']).optional().describe('Dirección de ordenación: asc o desc.')
});

const outputSchema = z.object({
  results: z.array(z.unknown()),
  pagination: z.record(z.string(), z.unknown()),
  meta: z.record(z.string(), z.unknown())
});

/**
 * Canonical sort allowlist. The backend resolves these to the *projected*
 * column aliases exposed by the UNION query (titulo, importe, fecha, ...),
 * so only these exact names are accepted. Do not add incompatible aliases
 * without a contract change.
 */
const SORT_ALLOWLIST: ReadonlySet<string> = new Set([
  'titulo',
  'organismo',
  'adjudicatario',
  'importe',
  'fuente',
  'fecha',
]);

class SearchInputError extends Error {}

function parseSort(rawSort: string | undefined): { sort?: string } {
  // Absent or empty: preserve the backend default (fecha). Do not send sort.
  if (rawSort === undefined || rawSort === '') {
    return {};
  }
  // Legacy colon syntax (e.g. "fecha:desc") is rejected explicitly. The
  // contract separates sort and dir; the combined form is not supported.
  if (rawSort.includes(':')) {
    throw new SearchInputError('Sintaxis de ordenación legacy no soportada. Usa sort=<campo> y dir=asc|desc separados.');
  }
  if (!SORT_ALLOWLIST.has(rawSort)) {
    throw new SearchInputError(`Campo de ordenación no soportado: "${rawSort}". Usa titulo, organismo, adjudicatario, importe, fuente o fecha.`);
  }
  return { sort: rawSort };
}

export function mapSearchParams(args: SearchParams): Record<string, unknown> {
  const {
    importe_min,
    importe_max,
    fecha_desde,
    fecha_hasta,
    sort: rawSort,
    dir: explicitDir,
    ...unchanged
  } = args;

  const { sort } = parseSort(rawSort);
  // Drop keys with undefined values so the mapped params are clean and
  // predictable; the API query-string builder also filters these, but a
  // compact object keeps the contract explicit in tests.
  return Object.fromEntries(
    Object.entries({
      ...unchanged,
      ...(sort ? { sort } : {}),
      importeMin: importe_min,
      importeMax: importe_max,
      desde: fecha_desde,
      hasta: fecha_hasta,
      dir: explicitDir,
    }).filter(([, v]) => v !== undefined)
  );
}

export function registerSearchTool(server: ToolRegistry, config: ElicitaApiConfig): void {
  server.registerTool(
    'search_licitaciones',
    {
      title: 'Buscar licitaciones',
      description: 'Busca licitaciones y contratos públicos en Elicita. Permite filtrar por texto libre, CPV, importe, estado, fuente, NIF y rango de fechas. Devuelve un resumen compacto y datos estructurados.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true }
    },
    async (args: SearchParams): Promise<ToolResult> => {
      try {
        const { data, upstreamMs } = await fetchElicitaTiming(config, '/api/v1/search', mapSearchParams(args));
        const structured = toStructuredSearchResponse(data);
        return {
          content: [
            {
              type: 'text',
              text: formatSearchResults(structured)
            },
            {
              type: 'text',
              text: JSON.stringify(structured)
            }
          ],
          structuredContent: structured,
          upstreamMs
        };
      } catch (err) {
        const result = errorResult(err);
        if (err && typeof err === 'object' && 'upstreamMs' in err) {
          result.upstreamMs = (err as { upstreamMs: number }).upstreamMs;
        }
        if (err && typeof err === 'object' && 'upstreamStatus' in err) {
          result.upstreamStatus = (err as { upstreamStatus: number }).upstreamStatus;
        }
        return result;
      }
    }
  );
}

export function toStructuredSearchResponse(data: unknown): {
  results: unknown[];
  pagination: Record<string, unknown>;
  meta: Record<string, unknown>;
} {
  if (!data || typeof data !== 'object') {
    throw new Error('Respuesta de búsqueda inválida');
  }

  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.results)) throw new Error('Respuesta de búsqueda inválida');
  const results = obj.results;
  const pagination = isRecord(obj.pagination) ? obj.pagination : {};
  const meta = isRecord(obj.meta) ? obj.meta : {};

  return { results, pagination, meta };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatSearchResults(data: ReturnType<typeof toStructuredSearchResponse>): string {
  if (!data || typeof data !== 'object') {
    return 'No se recibieron resultados de búsqueda.';
  }

  const total = data.meta.total ?? 'desconocido';
  const results = data.results;

  let md = `Resultados: ${total} total; ${results.length} en esta página.\n`;

  if (results.length === 0) {
    md += 'No se encontraron licitaciones con los filtros indicados.';
    return md;
  }

  for (const item of results.slice(0, 5)) {
    md += formatResultItem(item);
    md += '\n';
  }

  return md.trimEnd();
}

function formatResultItem(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const o = item as Record<string, unknown>;

  const titulo = String(o.titulo || o.title || o.denominacion || o.objeto || 'Sin título');
  const organismo = String(o.organismo || o.entidad || o.buyer_name || 'Organismo no disponible');
  const nif = String(o.nif || o.buyer_nif || '');
  const importe = formatImporte(o.importe ?? o.importe_licitacion ?? o.presupuesto ?? o.value_amount);
  const estado = String(o.estado || o.status || '');
  const fuente = String(o.fuente || o.source || '');
  const fecha = String(o.fecha_publicacion || o.fecha || o.publication_date || '');
  const url = String(o.url || o.url_pub || o.permalink || o.enlace || '');
  const id = String(o.id || o.contract_id || '');

  let md = `- **${titulo}** — ${organismo}${nif ? ` (${nif})` : ''}`;
  const details = [id && `ID ${id}`, importe, estado, fuente, fecha].filter(Boolean);
  if (details.length > 0) md += ` · ${details.join(' · ')}`;
  if (url) md += ` · ${url}`;

  return md;
}

function formatImporte(value: unknown): string {
  if (value === undefined || value === null) return '';
  const num = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (Number.isNaN(num)) return String(value);
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(num);
}

function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: 'text',
        text: `Error al buscar licitaciones: ${message}`
      }
    ],
    isError: true,
    ...(err instanceof SearchInputError ? { upstreamStatus: 400 } : {})
  };
}
