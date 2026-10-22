import { z } from 'zod';
import { readFileSync } from 'node:fs';

import type { ElicitaApiConfig, ToolResult } from '../lib/types.js';
import type { ToolRegistry } from '../lib/tool-registry.js';

const inputSchema = z.object({
  q: z.string().min(1).describe('Texto para buscar códigos CPV (p. ej. "software", "construcción", "servicios médicos").'),
  limit: z.number().int().min(1).max(50).default(10).describe('Máximo de resultados a devolver (1-50).')
});

let cpvCache: Record<string, string> | null = null;

function loadCpv(): Record<string, string> {
  if (cpvCache) return cpvCache;
  try {
    const raw = readFileSync(new URL('../../../web/src/data/cpv_es.json', import.meta.url), 'utf-8');
    cpvCache = JSON.parse(raw);
    return cpvCache!;
  } catch { /* report a safe error */ }
  throw new Error('No se pudo cargar el diccionario CPV');
}

export function registerCpvTool(server: ToolRegistry, _config: ElicitaApiConfig): void {
  server.registerTool(
    'search_cpv',
    {
      title: 'Buscar códigos CPV',
      description: 'Busca códigos CPV (Common Procurement Vocabulary) por texto en español. Útil para descubrir el código exacto que luego se puede usar como filtro en search_licitaciones.',
      inputSchema,
      annotations: { readOnlyHint: true }
    },
    async (args: { q: string; limit: number }): Promise<ToolResult> => {
      try {
        const cpv = loadCpv();
        const query = args.q.toLowerCase();
        const matches: Array<{ code: string; desc: string }> = [];

        for (const [code, desc] of Object.entries(cpv)) {
          if (desc.toLowerCase().includes(query) || code.includes(query)) {
            matches.push({ code, desc });
            if (matches.length >= args.limit) break;
          }
        }

        if (matches.length === 0) {
          return { content: [{ type: 'text', text: `No se encontraron códigos CPV para "${args.q}".` }] };
        }

        let md = `# Códigos CPV para "${args.q}"\n\n`;
        for (const m of matches) {
          md += `- **${m.code}** — ${m.desc}\n`;
        }

        return { content: [{ type: 'text', text: md }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error al buscar códigos CPV: ${message}` }],
          isError: true
        };
      }
    }
  );
}