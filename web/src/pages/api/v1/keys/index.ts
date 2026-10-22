/**
 * API Keys management endpoints
 * POST /api/v1/keys - Create new API key
 * GET /api/v1/keys - List API keys (metadata only, no secrets)
 *
 * Internal mode: MCP server can create keys by passing X-Clerk-User-Id header
 * + CLERK_SECRET_KEY as Bearer token (service-to-service).
 */
import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import { generateApiKey, getQueriesLimit, canUseMcp, saveApiKey, listApiKeysByUser } from '../../../../lib/api-keys';
import { getUserPlan } from '../../../../lib/plan';

/**
 * Authenticate via Clerk session OR internal service token
 */
async function authenticate(request: Request, locals: any): Promise<string | null> {
  // Try internal service auth (MCP server → API)
  const authHeader = request.headers.get('authorization');
  const clerkUserId = request.headers.get('x-clerk-user-id');
  const clerkSecret = import.meta.env.CLERK_SECRET_KEY;

  if (authHeader && clerkUserId && clerkSecret) {
    const token = authHeader.replace('Bearer ', '');
    // If the token matches CLERK_SECRET_KEY, it's an internal call
    if (token === clerkSecret) {
      return clerkUserId;
    }
  }

  // Fall back to Clerk session
  const auth = locals.auth?.();
  return auth?.userId || null;
}

/**
 * POST /api/v1/keys
 * Creates a new API key for the authenticated user
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const userId = await authenticate(request, locals);

    if (!userId) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get user plan
    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(userId);
    const metadata = (user.publicMetadata || {}) as Record<string, any>;
    const userPlan = getUserPlan(metadata, user.username, userId);

    // API keys require Pro or Enterprise plan
    if (userPlan.plan !== 'empresa' && userPlan.plan !== 'pro' && userPlan.plan !== 'developer') {
      return new Response(JSON.stringify({ 
        error: 'API access requires Enterprise plan',
        upgrade_required: true 
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get key name from request
    const body = await request.json().catch(() => ({}));
    const name = body.name || `Key ${new Date().toISOString().slice(0, 10)}`;

    // Generate and persist key
    const { key, apiKey } = generateApiKey(userId, name);
    await saveApiKey(apiKey);

    // Update Clerk metadata with API enabled
    await client.users.updateUserMetadata(userId, {
      publicMetadata: {
        ...metadata,
        api_enabled: true,
        queries_limit: getQueriesLimit(userPlan.plan),
      },
    });

    return new Response(JSON.stringify({
      success: true,
      key, // Full key shown only once!
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        prefix: apiKey.prefix,
        createdAt: apiKey.createdAt,
      },
      warning: 'Store this key securely. It will not be shown again.',
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * GET /api/v1/keys
 * List API keys for the authenticated user (metadata only)
 */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const userId = await authenticate(request, locals);

    if (!userId) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch persisted keys for the user
    const userKeys = await listApiKeysByUser(userId);
    const keys = userKeys.map(k => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
    }));

    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
