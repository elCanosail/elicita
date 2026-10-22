/**
 * POST /api/stripe/portal
 * Creates a Stripe Customer Portal session for managing subscriptions
 * (cancel, change plan, update payment method, view invoices)
 */
import type { APIRoute } from 'astro';
import { stripe } from '../../../lib/stripe';
import { clerkClient } from '@clerk/astro/server';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const auth = locals.auth?.();
    const userId = auth?.userId;
    if (!userId) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), { status: 401 });
    }

    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(userId);
    const customerId = (user.publicMetadata as any)?.stripe_customer_id;

    if (!customerId) {
      return new Response(JSON.stringify({ error: 'No hay suscripción activa' }), { status: 400 });
    }

    const origin = new URL(request.url).origin;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/cuenta/plan`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[Stripe Portal]', err);
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
};
