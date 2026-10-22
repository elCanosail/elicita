/**
 * POST /api/test/checkout-flow
 * Endpoint temporal SOLO para test end-to-end del checkout Stripe.
 */
import type { APIRoute } from "astro";
import { stripe, PLANS, IVA_TAX_RATE_ID } from "../../../lib/stripe";
import { adminGuard, isDevelopment } from "../../../lib/internal-guard";

export const POST: APIRoute = async ({ request }) => {
  // Solo en desarrollo local o con el secreto admin (ADMIN_API_KEY). En
  // produccion el gate queda fail-closed si el secreto no esta definido.
  if (!isDevelopment()) {
    const denied = adminGuard(request);
    if (denied) return denied;
  }
  try {
    const body = await request.json().catch(() => ({}));
    const userId = body.userId || "user_test";
    const planId = "pro";
    const interval = "month";
    const origin = new URL(request.url).origin;
    const plan = PLANS[planId];
    const priceId = plan.prices.monthly;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: origin + "/cuenta/plan?success=true",
      cancel_url: origin + "/cuenta/plan",
      client_reference_id: userId,
      tax_id_collection: { enabled: true },
      metadata: { clerk_user_id: userId, plan: planId, interval },
      subscription_data: { default_tax_rates: [IVA_TAX_RATE_ID], metadata: { clerk_user_id: userId, plan: planId } },
    });
    return new Response(JSON.stringify({ ok: true, checkout_session_id: session.id, url: session.url, price_id: priceId, user_id: userId }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};
