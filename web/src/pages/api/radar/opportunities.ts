/**
 * Radar Opportunities API — T6 contract-first endpoint.
 *
 * GET /api/radar/opportunities?fuente=TED&estimation_status=contractual_scenario&limit=20&offset=0
 *
 * Returns opportunities that have been *previously estimable* (have
 * valid duration + date anchor). When real data lineage is unconfirmed,
 * returns a safe-empty response with explanation.
 *
 * Contract rules:
 * - Never fabricates data — only exposes records from the injected
 *   adapter (synthetic fixtures, not production).
 * - Always includes: estimation_status, estimated_end_date, basis,
 *   confidence (null), evidencia.
 * - When lineage is unconfirmed: safe_empty response.
 *
 * Source: web/src/pages/api/radar/opportunities.ts
 */

import type { APIRoute } from 'astro';
import { RadarQuerySchema, RadarResponseSchema, safeEmptyResponse } from '../../../lib/radar/contract';
import { queryRadar, getSafeExplanation } from '../../../lib/radar/injection';

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);

    // Parse query parameters
    const query: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) {
      query[key] = value;
    }

    // Validate query against contract schema
    const queryResult = RadarQuerySchema.safeParse(query);
    if (!queryResult.success) {
      const errors = queryResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return new Response(
        JSON.stringify({ error: 'invalid_query', details: errors }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const parsedQuery = queryResult.data;

    // Query the injected adapter
    const result = queryRadar({
      fuente: parsedQuery.fuente,
      estimation_status: parsedQuery.estimation_status,
      cpv: parsedQuery.cpv,
      organismo: parsedQuery.organismo,
      limit: parsedQuery.limit,
      offset: parsedQuery.offset,
    });

    // Build response
    const response = {
      opportunities: result.opportunities,
      pagination: {
        total: result.total,
        limit: parsedQuery.limit,
        offset: parsedQuery.offset,
      },
      meta: {
        lineage_confirmed: result.lineageConfirmed,
        coverage_status: result.safeEmpty ? 'safe_empty' : 'partial',
        ...(result.safeEmpty
          ? { explanation: getSafeExplanation() }
          : {}),
      },
    };

    // Validate the complete output envelope before returning it.
    const output = RadarResponseSchema.safeParse(response);
    if (!output.success) {
      console.error('Radar response failed contract validation:', output.error.issues);
      return new Response(
        JSON.stringify(safeEmptyResponse('Respuesta Radar no verificable; no se exponen datos.')),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
      );
    }

    return new Response(JSON.stringify(output.data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Radar opportunities API error:', err);
    return new Response(
      JSON.stringify({ error: 'internal_server_error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};