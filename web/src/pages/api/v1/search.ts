/**
 * API Search endpoint
 * GET /api/v1/search?q=...&cpv=...&date_from=...&date_to=...
 * Requires: API Key or Clerk session
 */
import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import { checkQueryBudget, incrementQueryCount, checkRateLimit } from '../../../lib/api-usage';
import { hashApiKey, isValidApiKeyFormat, getApiKeyByHash, updateLastUsed } from '../../../lib/api-keys';
import { buildUnionQuery, query } from '../../../lib/search';

async function authenticate(request: Request, locals: any): Promise<{ userId: string; plan: string } | null> {
  // Try API Key first (Authorization: Bearer ***)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const key = authHeader.slice(7);
    if (isValidApiKeyFormat(key)) {
      const keyHash = hashApiKey(key);
      const apiKey = await getApiKeyByHash(keyHash);
      if (apiKey && !apiKey.revoked) {
        // Update last used timestamp asynchronously; don't block auth on failure
        updateLastUsed(apiKey.id).catch(() => {});
        try {
          const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
          const user = await client.users.getUser(apiKey.userId);
          const metadata = (user.publicMetadata || {}) as Record<string, any>;
          const plan = metadata?.plan || 'free';
          return { userId: apiKey.userId, plan };
        } catch {
          return null;
        }
      }
    }
  }

  // Try Clerk session
  const auth = locals.auth?.();
  if (auth?.userId) {
    try {
      const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
      const user = await client.users.getUser(auth.userId);
      const metadata = (user.publicMetadata || {}) as Record<string, any>;
      const plan = metadata?.plan || 'free';
      return { userId: auth.userId, plan };
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeFilters(url: URL): Record<string, string> {
  const filters: Record<string, string> = {};
  const mappings: Record<string, string> = {
    cpv: 'cpv',
    importeMin: 'importeMin',
    importeMax: 'importeMax',
    estado: 'estado',
    fuente: 'fuente',
    nif: 'nif',
    desde: 'desde',
    hasta: 'hasta',
    limit: 'limit',
    offset: 'offset',
    sort: 'sort',
    dir: 'dir',
  };

  for (const [param, filterKey] of Object.entries(mappings)) {
    const v = url.searchParams.get(param);
    if (v) filters[filterKey] = v;
  }

  return filters;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();

  try {
    // Authenticate
    const auth = await authenticate(request, locals);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized. Use API Key (Authorization: Bearer ...) or sign in.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // API access requires Pro or Enterprise plan
    if (auth.plan !== 'empresa' && auth.plan !== 'pro' && auth.plan !== 'developer') {
      return new Response(JSON.stringify({
        error: 'API access requires the Pro plan',
        upgrade_url: '/precios'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get user plan details for limits
    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const metadata = (user.publicMetadata || {}) as Record<string, any>;
    const queriesLimit = metadata?.queries_limit || 0;

    // Check query budget
    const budget = await checkQueryBudget(auth.userId, queriesLimit);
    if (!budget.allowed) {
      return new Response(JSON.stringify({
        error: 'Query quota exceeded',
        queries_used: queriesLimit,
        queries_limit: queriesLimit,
        upgrade_url: '/pricing'
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '86400' },
      });
    }

    // Rate limit: generous for all authenticated users
    const rateLimit = { maxTokens: 1000, refillRate: 1 };
    const rateCheck = checkRateLimit(auth.userId, rateLimit.maxTokens, rateLimit.refillRate);
    if (!rateCheck.allowed) {
      return new Response(JSON.stringify({
        error: 'Rate limit exceeded',
        retry_after: Math.ceil(rateCheck.resetTime - Date.now() / 1000)
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': String(rateLimit.maxTokens),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(rateCheck.resetTime)),
        },
      });
    }

    // Parse query params
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.trim() || '';
    const filters = normalizeFilters(url);
    const limit = Math.min(parseInt(filters.limit || '20'), 100);
    const offset = parseInt(filters.offset || '0') || 0;

    // Ensure filters has the user-supplied limit/offset (not exceeding internal max)
    filters.limit = String(limit);
    filters.offset = String(offset);

    if (!q && !Object.keys(filters).some(k => k !== 'limit' && k !== 'offset')) {
      return new Response(JSON.stringify({ error: 'Introduce un término de búsqueda o filtro' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { dataSql, countSql, limit: pageLimit } = buildUnionQuery(q, filters);

    // Run data + count in parallel
    const [rawRows, countResult] = await Promise.all([
      query(dataSql),
      query(countSql),
    ]);

    const rawTotal = countResult[0]?.total;
    const total = typeof rawTotal === 'bigint' ? Number(rawTotal) : (rawTotal || 0);
    const hasMore = rawRows.length > pageLimit;
    if (hasMore) rawRows.pop();

    // Convert BigInt to Number for JSON serialization
    const results = rawRows.map((r: any) => {
      const out: any = {};
      for (const [k, v] of Object.entries(r)) {
        out[k] = typeof v === 'bigint' ? Number(v) : v;
      }
      if ("_score" in out) delete out._score;
      return out;
    });

    // Increment query count
    await incrementQueryCount(auth.userId);

    return new Response(JSON.stringify({
      ok: true,
      query: {
        q,
        filters: {
          cpv: filters.cpv || undefined,
          importeMin: filters.importeMin || undefined,
          importeMax: filters.importeMax || undefined,
          estado: filters.estado || undefined,
          fuente: filters.fuente || undefined,
          nif: filters.nif || undefined,
          desde: filters.desde || undefined,
          hasta: filters.hasta || undefined,
        },
      },
      results,
      pagination: {
        limit,
        offset,
        has_more: hasMore,
      },
      meta: {
        took_ms: Date.now() - startTime,
        queries_remaining: budget.remaining - 1,
        rate_limit_remaining: rateCheck.remaining,
        total: total === -1 ? undefined : total,
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-RateLimit-Limit': String(rateLimit.maxTokens),
        'X-RateLimit-Remaining': String(rateCheck.remaining),
        'X-RateLimit-Reset': String(Math.ceil(rateCheck.resetTime)),
      },
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
