/**
 * POST /api/stripe/webhook
 * Handles Stripe webhook events for subscription lifecycle
 * 
 * Since Elicita doesn't have its own DB for subscriptions yet,
 * we store subscription data in Clerk user metadata.
 */
import type { APIRoute } from 'astro';
import { stripe, getPlanFromPriceId } from '../../../lib/stripe';
import { clerkClient } from '@clerk/astro/server';
import { getQueriesLimit, canUseMcp } from '../../../lib/api-keys';
import { notifyPurchase } from '../../../lib/notify';
import { sendEmail } from '../../../lib/resend';

export const POST: APIRoute = async ({ request }) => {
  const sig = request.headers.get('stripe-signature');
  const webhookSecret = import.meta.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return new Response('Missing signature or secret', { status: 400 });
  }

  let event;
  try {
    const body = await request.text();
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err);
    return new Response('Invalid signature', { status: 400 });
  }

  const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const clerkUserId = session.client_reference_id || session.metadata?.clerk_user_id;
        if (!clerkUserId) break;

        // Get subscription details
        const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
        const priceId = subscription.items.data[0]?.price.id;
        const plan = getPlanFromPriceId(priceId || '');

        const planId = plan?.id || session.metadata?.plan || 'pro';
        await client.users.updateUserMetadata(clerkUserId, {
          publicMetadata: {
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
            plan: planId,
            plan_status: 'active',
            plan_interval: subscription.items.data[0]?.price.recurring?.interval || 'year',
            plan_current_period_end: subscription.current_period_end,
            // API/MCP features
            api_enabled: planId === 'pro' || planId === 'empresa',
            mcp_enabled: canUseMcp(planId),
            queries_limit: getQueriesLimit(planId),
            queries_used_this_month: 0,
          },
        });

        console.log(`[Stripe] ✓ checkout.session.completed — ${clerkUserId} → ${plan?.name || 'unknown'}`);

        // Notificación interna + email de bienvenida al cliente con CTA de activación
        try {
          const user = await client.users.getUser(clerkUserId);
          const userEmail = user.emailAddresses?.[0]?.emailAddress || '';
          await notifyPurchase({
            clerkUserId,
            email: userEmail || 'N/A',
            planName: plan?.name || planId,
            amount: session.amount_total,
            interval: subscription.items.data[0]?.price.recurring?.interval,
            customerId: session.customer as string,
          });
          if (userEmail) {
            await sendEmail({
              to: userEmail,
              subject: 'Bienvenido a Elicita Pro — activa tu API key',
              text: `Gracias por suscribirte al plan ${plan?.name || planId} de Elicita.\n\nSiguientes pasos:\n\n1. Crea tu API key (el secreto se muestra una sola vez): https://elicita.es/docs/api\n2. Conecta tu agente al MCP: https://elicita.es/docs/mcp\n3. Explora los 7 sectores cartografiados: https://elicita.es/mercado\n\nTu plan ya está activo en tu cuenta: https://elicita.es/cuenta/plan\n\nSi algo no funciona en los primeros minutos, responde a este email — te contestamos nosotros, no un bot.`,
            });
          }
        } catch (notifyErr) {
          console.error('[Stripe Webhook] Error enviando notificación de compra:', notifyErr);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const clerkUserId = subscription.metadata?.clerk_user_id;
        if (!clerkUserId) break;

        const priceId = subscription.items.data[0]?.price.id;
        const plan = getPlanFromPriceId(priceId || '');

        const planId = plan?.id || 'pro';
        await client.users.updateUserMetadata(clerkUserId, {
          publicMetadata: {
            plan: planId,
            plan_status: subscription.status === 'active' ? 'active' : subscription.status,
            plan_interval: subscription.items.data[0]?.price.recurring?.interval || 'year',
            plan_current_period_end: subscription.current_period_end,
            // API/MCP features (preserve existing if downgrading)
            api_enabled: subscription.status === 'active' && (planId === 'pro' || planId === 'empresa'),
            mcp_enabled: subscription.status === 'active' && canUseMcp(planId),
            queries_limit: getQueriesLimit(planId),
          },
        });

        console.log(`[Stripe] ✓ subscription.updated — ${clerkUserId} → ${plan?.name} (${subscription.status})`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const clerkUserId = subscription.metadata?.clerk_user_id;
        if (!clerkUserId) break;

        await client.users.updateUserMetadata(clerkUserId, {
          publicMetadata: {
            plan: 'free',
            plan_status: 'cancelled',
            plan_current_period_end: null,
            api_enabled: false,
            mcp_enabled: false,
            queries_limit: 0,
            queries_used_this_month: 0,
          },
        });

        console.log(`[Stripe] ✓ subscription.deleted — ${clerkUserId} → free`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId = invoice.subscription as string;
        if (!subId) break;

        const subscription = await stripe.subscriptions.retrieve(subId);
        const clerkUserId = subscription.metadata?.clerk_user_id;
        if (!clerkUserId) break;

        await client.users.updateUserMetadata(clerkUserId, {
          publicMetadata: {
            plan_status: 'past_due',
          },
        });

        console.log(`[Stripe] ⚠ payment_failed — ${clerkUserId}`);
        break;
      }
    }
  } catch (err) {
    console.error(`[Stripe Webhook] Error processing ${event.type}:`, err);
    // Devolver 500 para que Stripe reintente con backoff — un 200 aquí pierde
    // el evento en silencio (cliente que pagó sin recibir Pro).
    try {
      await sendEmail({
        to: 'contacto@elicita.es',
        subject: `[Elicita] Webhook Stripe falló: ${event.type}`,
        text: `El webhook de Stripe no pudo procesar el evento ${event.type} (id ${event.id}). Stripe lo reintentará; si persiste, revisar logs del servicio web.`,
      });
    } catch {}
    return new Response(JSON.stringify({ error: 'Webhook processing error — will retry' }), { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
};
