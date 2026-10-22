import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchElicita } from '../lib/api-client.js';
import type { ElicitaApiConfig, ToolResult } from '../lib/types.js';

const inputSchema = z.object({
  nif: z.string().min(1).describe('NIF del organismo público (p. ej. "S2811001B").')
});

export function registerOrganismoTool(server: McpServer, config: ElicitaApiConfig): void {
  server.registerTool(
    'get_organismo',
    {
      title: 'Información de organismo',
      description: 'Devuelve información agregada de un organismo público a partir de su NIF: nombre, tipo, localidad, importe total contratado, número de contratos y principales licitaciones.',
      inputSchema,
      annotations: { readOnlyHint: true }
    },
    async (args): Promise<ToolResult> => {
      try {
        if (!config.apiKey) {
          return { content: [{ type: 'text', text: 'Esta herramienta requiere una petición autenticada con OAuth o API key de Elicita.' }], isError: true };
        }
        const data = await fetchElicita(config, '/api/v1/organismos', { nif: args.nif });
        return {
          content: [
            {
              type: 'text',
              text: formatOrganismo(data)
            }
          ]
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

function formatOrganismo(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return 'No se recibió información del organismo.';
  }

  const o = data as Record<string, unknown>;
  const nombre = String(o.nombre || o.name || o.razon_social || o.entidad || 'Organismo desconocido');
  const nif = String(o.nif || o.nif_cif || '');
  const tipo = String(o.tipo || o.tipo_administracion || o.tipo_organismo || '');
  const localidad = String(o.localidad || o.municipio || o.provincia || '');
  const contratos = o.contratos ?? o.numero_contratos ?? o.total_contracts ?? '—';
  const importe = formatImporte(o.importe_total ?? o.total_importe ?? o.total_amount);

  let md = `# ${nombre}\n\n`;
  if (nif) md += `- **NIF:** ${nif}\n`;
  if (tipo) md += `- **Tipo:** ${tipo}\n`;
  if (localidad) md += `- **Localidad:** ${localidad}\n`;
  md += `- **Contratos:** ${contratos}\n`;
  if (importe) md += `- **Importe total:** ${importe}\n`;

  const licitaciones = Array.isArray(o.licitaciones) ? o.licitaciones : Array.isArray(o.contratos_recientes) ? o.contratos_recientes : [];
  if (licitaciones.length > 0) {
    md += '\n## Últimos contratos\n\n';
    for (const item of licitaciones.slice(0, 10)) {
      md += formatContrato(item);
      md += '\n';
    }
  }

  return md;
}

function formatContrato(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const o = item as Record<string, unknown>;
  const titulo = String(o.titulo || o.title || o.objeto || 'Sin título');
  const importe = formatImporte(o.importe ?? o.presupuesto ?? o.amount);
  const fecha = String(o.fecha_publicacion || o.fecha || '');
  const estado = String(o.estado || o.status || '');

  let line = `- **${titulo}**`;
  const meta: string[] = [];
  if (importe) meta.push(importe);
  if (fecha) meta.push(fecha);
  if (estado) meta.push(estado);
  if (meta.length) line += ` (${meta.join(', ')})`;
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
        text: `Error al obtener información del organismo: ${message}`
      }
    ],
    isError: true
  };
}
