import { z } from 'zod';
import { fetchElicitaTiming } from '../lib/api-client.js';
import type { ElicitaApiConfig, ToolResult } from '../lib/types.js';
import type { ToolRegistry } from '../lib/tool-registry.js';

const inputSchema = z.object({}).optional();

export function registerStatsTool(server: ToolRegistry, config: ElicitaApiConfig): void {
  server.registerTool(
    'get_stats',
    {
      title: 'Estadísticas del dataset',
      description: 'Devuelve estadísticas generales del dataset de Elicita: total de registros, número de fuentes cubiertas y fecha de última actualización.',
      inputSchema,
      annotations: { readOnlyHint: true }
    },
    async (): Promise<ToolResult> => {
      try {
        const { data, upstreamMs } = await fetchElicitaTiming(config, '/api/stats', {});
        return {
          content: [
            {
              type: 'text',
              text: formatStats(data)
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

export function formatStats(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return 'No se recibieron estadísticas.';
  }

  const o = data as Record<string, unknown>;
  const total = o.totalHistorical ?? o.total ?? o.total_records ?? o.records ?? '—';
  const fuentes = o.fuentes ?? o.sources ?? o.fuentes_count ?? '—';
  const ultima = o.lastUpdate || o.ultima_actualizacion || o.last_update || o.updated_at || '—';

  const formattedTotal =
    typeof total === 'number'
      ? total.toLocaleString('es-ES')
      : String(total);

  let md = '# Estadísticas de Elicita\n\n';
  md += `- **Registros históricos (no contratos únicos):** ${formattedTotal}\n`;

  // Formatear fuentes — puede ser array de objetos o número
  if (Array.isArray(fuentes)) {
    md += `- **Fuentes cubiertas:** ${fuentes.length}\n`;
    md += '\n## Desglose por fuente\n\n';
    for (const f of fuentes) {
      if (typeof f === 'object' && f !== null) {
        const fo = f as Record<string, unknown>;
        const nombre = String(fo.nombre || fo.name || fo.fuente || '—');
        const count = fo.count ?? fo.total ?? fo.registros ?? '—';
        md += `- **${nombre}:** ${typeof count === 'number' ? count.toLocaleString('es-ES') : count}\n`;
      } else {
        md += `- ${String(f)}\n`;
      }
    }
  } else {
    md += `- **Fuentes cubiertas:** ${fuentes}\n`;
  }

  md += `- **Última actualización del pipeline:** ${ultima}\n`;

  if (o.top_fuentes || o.sources_detail) {
    const detail = (o.top_fuentes ?? o.sources_detail) as Record<string, unknown> | undefined;
    if (detail && typeof detail === 'object') {
      md += '\n## Desglose por fuente\n\n';
      for (const [fuente, count] of Object.entries(detail)) {
        md += `- **${fuente}:** ${typeof count === 'number' ? count.toLocaleString('es-ES') : count}\n`;
      }
    }
  }

  md += '\nNo se suman histórico, BORME y pipeline: pueden solaparse y representan universos distintos.\n';
  return md;
}

function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: 'text',
        text: `Error al obtener estadísticas: ${message}`
      }
    ],
    isError: true
  };
}
