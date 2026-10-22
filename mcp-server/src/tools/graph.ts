import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchElicita } from '../lib/api-client.js';
import type { ElicitaApiConfig, ToolResult } from '../lib/types.js';

const graphSearchSchema = z.object({
  nif: z.string().min(1).describe('NIF del organismo central del grafo.'),
  depth: z.number().int().min(1).max(3).default(2).describe('Profundidad del grafo (1-3).'),
  limit: z.number().int().min(1).max(200).default(50).describe('Máximo de nodos a devolver.')
});

const graphContractsSchema = z.object({
  id: z.string().min(1).describe('ID del contrato en Elicita.'),
  limit: z.number().int().min(1).max(100).default(20).describe('Máximo de contratos relacionados a devolver.')
});

export function registerGraphTools(server: McpServer, config: ElicitaApiConfig): void {
  server.registerTool(
    'graph_search',
    {
      title: 'Grafo de contratos de un organismo',
      description: 'Obtiene un grafo de relaciones contractuales de un organismo a partir de su NIF: organismos, empresas y contratos relacionados. Útil para análisis de incidencia y redes.',
      inputSchema: graphSearchSchema,
      annotations: { readOnlyHint: true }
    },
    async (args): Promise<ToolResult> => {
      try {
        if (!config.apiKey) {
          return { content: [{ type: 'text', text: 'Esta herramienta requiere una petición autenticada con OAuth o API key de Elicita.' }], isError: true };
        }
        const data = await fetchElicita(config, '/api/v1/graph-search', {
          nif: args.nif,
          depth: args.depth,
          limit: args.limit
        });
        return {
          content: [
            {
              type: 'text',
              text: formatGraph(data)
            }
          ]
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'graph_contracts',
    {
      title: 'Contratos relacionados',
      description: 'Dado el ID de un contrato, devuelve contratos relacionados por organismo, CPV, importe o adjudicatario.',
      inputSchema: graphContractsSchema,
      annotations: { readOnlyHint: true }
    },
    async (args): Promise<ToolResult> => {
      try {
        if (!config.apiKey) {
          return { content: [{ type: 'text', text: 'Esta herramienta requiere una petición autenticada con OAuth o API key de Elicita.' }], isError: true };
        }
        const data = await fetchElicita(config, '/api/v1/graph-contracts', {
          id: args.id,
          limit: args.limit
        });
        return {
          content: [
            {
              type: 'text',
              text: formatContracts(data)
            }
          ]
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

function formatGraph(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return 'No se recibió información del grafo.';
  }

  const o = data as Record<string, unknown>;
  const nodes = Array.isArray(o.nodes) ? o.nodes : [];
  const edges = Array.isArray(o.edges) ? o.edges : [];

  let md = `# Grafo de contratos\n\n`;
  md += `- **Nodos:** ${nodes.length}\n`;
  md += `- **Relaciones:** ${edges.length}\n\n`;

  if (nodes.length > 0) {
    md += '## Nodos\n\n';
    for (const node of nodes.slice(0, 50)) {
      md += formatNode(node);
      md += '\n';
    }
  }

  if (edges.length > 0) {
    md += '\n## Relaciones\n\n';
    for (const edge of edges.slice(0, 50)) {
      md += formatEdge(edge);
      md += '\n';
    }
  }

  return md;
}

function formatNode(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const o = item as Record<string, unknown>;
  const id = String(o.id || '');
  const label = String(o.label || o.nombre || o.name || o.razon_social || 'Sin nombre');
  const tipo = String(o.tipo || o.type || '');
  return `- **${label}**${tipo ? ` (${tipo})` : ''}${id ? ` — id: \`${id}\`` : ''}`;
}

function formatEdge(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const o = item as Record<string, unknown>;
  const source = String(o.source || o.origen || o.from || '—');
  const target = String(o.target || o.destino || o.to || '—');
  const tipo = String(o.tipo || o.type || o.relacion || '');
  const importe = formatImporte(o.importe ?? o.amount);

  let line = `- \`${source}\` → \`${target}\``;
  const meta: string[] = [];
  if (tipo) meta.push(tipo);
  if (importe) meta.push(importe);
  if (meta.length) line += ` (${meta.join(', ')})`;
  return line;
}

function formatContracts(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return 'No se recibieron contratos relacionados.';
  }

  const o = data as Record<string, unknown>;
  const results = Array.isArray(o.results) ? o.results : Array.isArray(o.data) ? o.data : Array.isArray(o.contracts) ? o.contracts : [];

  if (results.length === 0) {
    return 'No se encontraron contratos relacionados.';
  }

  let md = '# Contratos relacionados\n\n';
  for (const item of results.slice(0, 30)) {
    md += formatContract(item);
    md += '\n';
  }

  if (results.length > 30) {
    md += `\n_Mostrando 30 de ${results.length} contratos._\n`;
  }

  return md;
}

function formatContract(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const o = item as Record<string, unknown>;
  const id = String(o.id || o.contract_id || '');
  const titulo = String(o.titulo || o.title || o.objeto || 'Sin título');
  const organismo = String(o.organismo || o.entidad || o.buyer_name || '');
  const importe = formatImporte(o.importe ?? o.presupuesto ?? o.amount);
  const estado = String(o.estado || o.status || '');

  let line = `- **${titulo}**`;
  if (id) line += ` (id: \`${id}\`)`;
  const meta: string[] = [];
  if (organismo) meta.push(`organismo: ${organismo}`);
  if (importe) meta.push(importe);
  if (estado) meta.push(estado);
  if (meta.length) line += ` — ${meta.join(', ')}`;
  return line;
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
        text: `Error en el grafo de contratos: ${message}`
      }
    ],
    isError: true
  };
}
