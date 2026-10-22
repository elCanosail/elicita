// src/lib/notify.ts — Internal notification emails
import { sendEmail } from './resend';

const NOTIFY_TO = import.meta.env.RESEND_TO || process.env.RESEND_TO || 'contacto@elicita.es';
const FROM = 'Elicita <noreply@elicita.es>';

/**
 * Notify when a new user registers (Clerk user.created webhook)
 */
export async function notifyNewUser(user: {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  createdAt?: number;
}): Promise<void> {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Sin nombre';
  const created = user.createdAt
    ? new Date(user.createdAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })
    : new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

  const text = `Nuevo usuario registrado en Elicita

Email: ${user.email}
Nombre: ${name}
ID: ${user.id}
Fecha: ${created}

Ver en Clerk: https://dashboard.clerk.com`;

  const result = await sendEmail({
    to: NOTIFY_TO,
    subject: '👤 Nuevo usuario en Elicita',
    text,
    from: FROM,
  });

  if (!result.ok) {
    console.error('[notify] Error enviando notificación de nuevo usuario:', result.error);
  }
}

/**
 * Notify when a subscription is purchased (Stripe checkout.session.completed)
 */
export async function notifyPurchase(data: {
  clerkUserId: string;
  email: string;
  planName: string;
  amount?: number;
  interval?: string;
  customerId?: string;
}): Promise<void> {
  const { clerkUserId, email, planName, amount, interval, customerId } = data;

  const priceText = amount
    ? `${(amount / 100).toFixed(2)}€/${interval || 'mes'}`
    : 'N/A';

  const text = `Nueva compra en Elicita 🎉

Plan: ${planName}
Precio: ${priceText}
Email: ${email}
User ID: ${clerkUserId}
Stripe Customer: ${customerId || 'N/A'}
Fecha: ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}

Ver en Stripe: https://dashboard.stripe.com`;

  const result = await sendEmail({
    to: NOTIFY_TO,
    subject: `🎉 Nueva compra — ${planName} (${priceText})`,
    text,
    from: FROM,
  });

  if (!result.ok) {
    console.error('[notify] Error enviando notificación de compra:', result.error);
  }
}