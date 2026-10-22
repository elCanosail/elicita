/**
 * MCP experimental tool: radar_opportunities (T6).
 *
 * ⚠️  EXPLICITLY EXPERIMENTAL — disabled by default.
 * This tool does NOT appear in the stable tools list (STABLE_TOOL_NAMES).
 * It is NOT activable by environment variable — only present in the
 * code, not registered in the server by default.
 *
 * Wraps the Radar opportunities endpoint with MCP transport.
 * Returns only previously estimable opportunities with full evidence.
 *
 * Source: mcp-server/src/tools/radar.ts
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchElicita } from '../lib/api-client.js';
import type { ElicitaApiConfig, ToolResult } from '../lib/types.js';

/**
 * Schema for the MCP input: mirrors the Radar query parameters.
 */
export const RadarInputSchema = z.object({
  fuente: z.enum(['PLACSP', 'PLACE', 'TED', 'ANDALUCIA', 'CATALUNYA', 'GALICIA', 'MADRID', 'EUSKADI', 'ASTURIAS', 'VALENCIA', 'BOE']).optional()
    .describe('Filter by source'),
  estimation_status: z.enum(['not_estimable', 'contractual_scenario', 'award_proxy_scenario']).optional()
    .describe('Filter by estimation status'),
  cpv: z.string().optional()
    .describe('Filter by CPV code or prefix'),
  organismo: z.string().optional()
    .describe('Filter by organism (substring match)'),
  limit: z.number().int().min(1).max(100).default(20)
    .describe('Max results (1-100)'),
  offset: z.number().int().min(0).default(0)
    .describe('Pagination offset'),
});

/**
 * Radar opportunity record (mirrors the web API contract).
 */
export const RadarOpportunitySchema = z.object({
  id: z.string(),
  lote: z.string().optional(),
  version: z.string().optional(),
  fuente: z.enum(['PLACSP', 'PLACE', 'TED', 'ANDALUCIA', 'CATALUNYA', 'GALICIA', 'MADRID', 'EUSKADI', 'ASTURIAS', 'VALENCIA', 'BOE']),
  expediente: z.string(),
  organismo: z.string(),
  objeto: z.string(),
  cpv: z.string().nullable(),
  importe_licitacion: z.number().nullable(),
  importe_adjudicacion: z.number().nullable(),
  adjudicatario: z.string().nullable(),
  fecha_publicacion: z.string().nullable(),
  fecha_adjudicacion: z.string().nullable(),
  fecha_inicio: z.string().nullable(),
  fecha_fin: z.string().nullable(),
  url: z.string().nullable(),
  duracion: z.object({ valor: z.number().positive(), unidad: z.enum(['DAY', 'MON', 'ANN']) }).nullable(),
  estimation_status: z.enum(['not_estimable', 'contractual_scenario', 'award_proxy_scenario']),
  estimated_end_date: z.string().nullable(),
  confidence: z.null(),
  basis: z.enum(['explicit_start', 'explicit_award_proxy']).nullable(),
  evidencia: z.object({
    campo_fuente: z.string().min(1),
    url: z.string().url().optional(),
    observed_at: z.string().optional(),
  }),
  es_sintetico: z.boolean(),
});

/**
 * ⚠️  This tool is EXPERIMENTAL and NOT registered by default.
 *
 * To use it, the caller must explicitly register it:
 *   registerRadarTool(server, config)  — registers it.
 *   registerToolset(server, config)    — does NOT include radar.
 *
 * The tool name "radar_opportunities" does NOT appear in
 * STABLE_TOOL_NAMES (mcp-server/src/server.ts).
 */
export function registerRadarTool(server: McpServer, config: ElicitaApiConfig): void {
  server.registerTool(
    'radar_opportunities',
    {
      title: 'Consultar oportunidades Radar (EXPERIMENTAL)',
      description:
        'EXPERIMENTAL: consulta oportunidades de renovación de contratos públicos ' +
        'identificadas por el motor temporal Radar. Devuelve solo oportunidades ' +
        'previamente estimables con evidencia verificable (estimation_status, ' +
        'estimated_end_date, basis, evidencia). NO estima ni infiere datos. ' +
        'Si los datos de producción no han sido validados, devuelve una respuesta ' +
        'segura vacía con explicación. confidence siempre null.',
      inputSchema: RadarInputSchema,
      annotations: { readOnlyHint: true }
    },
    async (args): Promise<ToolResult> => {
      try {
        const validated = RadarInputSchema.parse(args);
        const params = mapRadarParams(validated);
        const data = await fetchElicita(config, '/api/radar/opportunities', params);

        if (!data || typeof data !== 'object') {
          return {
            content: [{ type: 'text', text: 'Respuesta Radar inválida del servidor.' }],
            isError: true,
          };
        }

        const obj = data as Record<string, unknown>;
        const opportunities = Array.isArray(obj.opportunities) ? obj.opportunities : [];
        const pagination: Record<string, unknown> = obj.pagination && typeof obj.pagination === 'object'
          ? obj.pagination as Record<string, unknown>
          : {};
        const meta: Record<string, unknown> = obj.meta && typeof obj.meta === 'object'
          ? obj.meta as Record<string, unknown>
          : {};

        // Validate each opportunity against the contract schema
        const validOps = opportunities
          .filter((opp: unknown) => {
            const result = RadarOpportunitySchema.safeParse(opp);
            return result.success;
          })
          .map((opp: unknown) => {
            const result = RadarOpportunitySchema.parse(opp);
            return result;
          });

        const text = formatRadarResponse({
          opportunities: validOps,
          pagination,
          meta,
        });

        return {
          content: [
            { type: 'text', text },
            { type: 'text', text: JSON.stringify({
              opportunities: validOps,
              pagination,
              meta,
            }) },
          ],
          structuredContent: {
            opportunities: validOps,
            pagination,
            meta,
          },
        };
      } catch (err) {
        const result = errorResult(err);
        return result;
      }
    }
  );
}

function mapRadarParams(args: z.infer<typeof RadarInputSchema>): Record<string, unknown> {
  const { limit, offset, ...rest } = args;
  return {
    ...rest,
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };
}

function formatRadarResponse(data: {
  opportunities: unknown[];
  pagination: Record<string, unknown>;
  meta: Record<string, unknown>;
}): string {
  if (!data || typeof data !== 'object') {
    return 'No se recibieron datos Radar.';
  }

  const { opportunities, pagination, meta } = data;
  const lineageConfirmed = (meta as Record<string, unknown>).lineage_confirmed;
  const coverageStatus = (meta as Record<string, unknown>).coverage_status as string;
  const explanation = (meta as Record<string, unknown>).explanation as string | undefined;

  let md = '';

  if (coverageStatus === 'safe_empty') {
    md += `⚠️ **Radar: cobertura segura vacía** (lineage no confirmado)\n`;
    md += explanation || 'Sin datos disponibles — procedencia no validada.';
    return md;
  }

  md += `Radar: ${opportunities.length} oportunidades; ${pagination?.total ?? '?'} total.\n`;

  if (opportunities.length === 0) {
    md += 'No se encontraron oportunidades con los filtros indicados.';
    return md;
  }

  for (const opp of opportunities.slice(0, 5)) {
    md += formatRadarItem(opp);
    md += '\n';
  }

  md += `\n*Lineage confirmado: ${lineageConfirmed ? 'Sí' : 'No'}*`;
  return md.trimEnd();
}

function formatRadarItem(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const o = item as Record<string, unknown>;

  const id = String(o.id || 'sin id');
  const fuente = String(o.fuente || '?');
  const organismo = String(o.organismo || '?');
  const objeto = String(o.objeto || '?');
  const estStatus = String(o.estimation_status || '?');
  const estEnd = o.estimated_end_date ? String(o.estimated_end_date) : 'null';
  const basis = o.basis ? String(o.basis) : 'null';
  const evidence = o.evidencia as Record<string, unknown> | undefined;
  const evidencia = evidence?.campo_fuente ? String(evidence.campo_fuente) : '?';
  const synthetic = o.es_sintetico ? ' [sintético]' : '';

  return `- **${id}** (${fuente}) — ${organismo} · ${objeto}\n  \`est=${estStatus}\` \`end=${estEnd}\` \`basis=${basis}\` \`evid=${evidencia}\`${synthetic}`;
}

function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: 'text',
        text: `Error en consulta Radar: ${message}`
      }
    ],
    isError: true,
  };
}