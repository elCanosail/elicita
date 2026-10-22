/**
 * GET /api/user-plan
 * Returns the current user's plan info
 */
import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import { getUserPlan } from '../../lib/plan';

export const GET: APIRoute = async ({ locals }) => {
  try {
    const auth = (locals as any).auth?.();
    const userId = auth?.userId;

    if (!userId) {
      return new Response(JSON.stringify({ plan: 'free', planName: 'Free', hasAccess: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(userId);
    const metadata = (user.publicMetadata || {}) as Record<string, any>;
    const userPlan = getUserPlan(metadata, user.username || undefined, userId);

    const { plan, planName, hasAccess, status, interval, periodEnd, apiEnabled, mcpEnabled, queriesLimit, maxAlerts } = userPlan;
    return new Response(
      JSON.stringify({ plan, planName, hasAccess, status, interval, periodEnd, apiEnabled, mcpEnabled, queriesLimit, maxAlerts }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error';
    return new Response(JSON.stringify({ error: message, plan: 'free', planName: 'Free', hasAccess: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
