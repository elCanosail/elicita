import { z } from 'zod';
import { fetchElicitaTiming } from '../lib/api-client.js';
import type { ElicitaApiConfig, ToolResult } from '../lib/types.js';
import type { ToolRegistry } from '../lib/tool-registry.js';

const inputSchema = z.object({}).optional();

export function registerCoberturaTool(server: ToolRegistry, config: ElicitaApiConfig): void {
  server.registerTool(
    'get_cobertura',
    {
      title: 'Cobertura de fuentes',
      description: 'Devuelve la cobertura actual de fuentes de licitaciones en Elicita: fuentes activas, periodicidad de actualización y resumen por tipo de publicador.',
      inputSchema,
      annotations: { readOnlyHint: true }
    },
    async (): Promise<ToolResult> => {
      try {
        const { data, upstreamMs } = await fetchElicitaTiming(config, '/api/cobertura', {});
        return {
          content: [
            {
              type: 'text',
              text: formatCobertura(data)
            }
          ],
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

export function formatCobertura(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return 'No se recibió información de cobertura.';
  }

  const o = data as Record<string, unknown>;
  const fuentes = Array.isArray(o.fuentes) ? o.fuentes : Array.isArray(o.sources) ? o.sources : [];
  const total = o.total ?? o.total_fuentes ?? fuentes.length;
  const ultima = o.globalLastRun || o.ultima_actualizacion || o.last_update || '—';

  let md = `# Cobertura de fuentes\n\n`;
  md += `- **Total de fuentes:** ${total}\n`;
  md += `- **Última ejecución global del pipeline (no frescura de todas las fuentes):** ${ultima}\n\n`;

  if (fuentes.length === 0) {
    md += 'No hay detalle de fuentes disponible.\n';
    return md;
  }

  md += '## Fuentes\n\n';
  for (const item of fuentes.slice(0, 50)) {
    md += formatFuente(item);
    md += '\n';
  }

  if (fuentes.length > 50) {
    md += `\n_Mostrando 50 de ${fuentes.length} fuentes._\n`;
  }

  return md;
}

function formatFuente(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const o = item as Record<string, unknown>;
  const nombre = String(o.nombre || o.name || o.fuente || o.source || 'Fuente sin nombre');
  const tipo = String(o.tipo || o.type || '');
  const activa = o.activa ?? o.active ?? null;
  const periodicidad = String(o.periodicidad || o.frequency || o.update_frequency || '');
  const registros = o.registros ?? o.records ?? o.count ?? null;

  let line = `- **${nombre}**`;
  if (tipo) line += ` (${tipo})`;
  const meta: string[] = [];
  meta.push(`última actualización de fuente: ${o.lastUpdate || 'desconocida'}`);
  if (periodicidad) meta.push(`periodicidad: ${periodicidad}`);
  if (registros !== null) meta.push(`registros: ${Number(registros).toLocaleString('es-ES')}`);
  if (activa !== null) meta.push(`activa: ${activa ? 'sí' : 'no'}`);
  if (meta.length) line += ` — ${meta.join(', ')}`;
  return line;
}

function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: 'text',
        text: `Error al obtener cobertura: ${message}`
      }
    ],
    isError: true
  };
}
