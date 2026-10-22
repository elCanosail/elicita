/**
 * POST /api/clerk/webhook
 * Handles Clerk webhook events (user.created, user.deleted)
 * Sends email notification to contacto@elicita.es on new sign-up
 *
 * Configure in Clerk Dashboard → Webhooks → Endpoint:
 *   URL: https://elicita.es/api/clerk/webhook
 *   Events: user.created
 */
import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { notifyNewUser } from '../../../lib/notify';
import { clerkClient } from '@clerk/astro/server';

/**
 * Verificación Svix (el estándar de Clerk) sin dependencia: HMAC-SHA256 de
 * "id.timestamp.body" con la clave base64 del secreto whsec_. Anti-replay de 5 min.
 */
function verifySvixSignature(secret: string, request: Request, body: string): boolean {
  try {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const timestamp = request.headers.get('svix-timestamp');
    const id = request.headers.get('svix-id');
    const signatureHeader = request.headers.get('svix-signature');
    if (!timestamp || !id || !signatureHeader) return false;
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false;
    const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
    return signatureHeader.split(' ').some((versioned) => {
      const [version, signature] = versioned.split(',');
      if (version !== 'v1' || !signature) return false;
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    });
  } catch {
    return false;
  }
}

export const POST: APIRoute = async ({ request }) => {
  const body = await request.text();

  // Verificación Svix estricta si hay secreto configurado; mientras no lo haya,
  // avisa fuerte y mantiene el comportamiento previo (no romper trials en vivo).
  const webhookSecret = import.meta.env.CLERK_WEBHOOK_SECRET || process.env.CLERK_WEBHOOK_SECRET;
  if (webhookSecret) {
    if (!verifySvixSignature(webhookSecret, request, body)) {
      console.error('[Clerk Webhook] ✗ Firma Svix inválida o ausente — rechazado');
      return new Response('Invalid signature', { status: 401 });
    }
  } else {
    console.error('[Clerk Webhook] ⚠ CLERK_WEBHOOK_SECRET no configurada — webhook SIN verificación de firma. Configurar en Clerk Dashboard → Webhooks → whsec_ y en el entorno del servicio.');
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const eventType = payload.type;

  switch (eventType) {
    case 'user.created': {
      const user = payload.data;
      if (!user) break;

      await notifyNewUser({
        id: user.id,
        email: user.email_addresses?.[0]?.email_address || 'sin email',
        firstName: user.first_name,
        lastName: user.last_name,
        createdAt: user.created_at,
      });

      console.log(`[Clerk Webhook] ✓ user.created — ${user.id} (${user.email_addresses?.[0]?.email_address})`);
      break;
    }

    case 'user.deleted': {
      const user = payload.data;
      console.log(`[Clerk Webhook] user.deleted — ${user?.id || 'unknown'}`);
      break;
    }

    default:
      // Ignore other events
      break;
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
};