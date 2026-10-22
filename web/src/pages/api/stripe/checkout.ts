/**
 * POST /api/stripe/checkout
 * Creates a Stripe Checkout session for a given plan + billing interval
 * Body: { plan: 'pro'|'empresa'|'developer', interval: 'month'|'year' }
 */
import type { APIRoute } from 'astro';
import { stripe, PLANS, IVA_TAX_RATE_ID, type PlanId } from '../../../lib/stripe';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const auth = locals.auth?.();
    const userId = auth?.userId;
    if (!userId) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), { status: 401 });
    }

    const body = await request.json();
    const { plan: planId, interval = 'month' } = body as { plan: PlanId; interval: 'month' | 'year' };

    const plan = PLANS[planId];
    if (!plan) {
      return new Response(JSON.stringify({ error: 'Plan no válido' }), { status: 400 });
    }

    const priceId = interval === 'year' ? plan.prices.annual : plan.prices.monthly;
    if (!priceId) {
      console.error(`[Stripe Checkout] Missing configured ${interval} price for plan ${planId}`);
      return new Response(JSON.stringify({ error: 'La contratación de este plan no está disponible todavía.' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const origin = new URL(request.url).origin;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/cuenta/plan?success=true`,
      cancel_url: `${origin}/cuenta/plan`,
      client_reference_id: userId,
      tax_id_collection: { enabled: true },
      subscription_data: {
        default_tax_rates: [IVA_TAX_RATE_ID],
        metadata: {
          clerk_user_id: userId,
          plan: planId,
        },
      },
      metadata: {
        clerk_user_id: userId,
        plan: planId,
        interval,
      },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[Stripe Checkout]', err);
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
};
