// src/lib/resend.ts
import { Resend } from 'resend';

const apiKey = import.meta.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;

export interface SendEmailArgs {
  to: string | string[];
  subject: string;
  text: string;
  from?: string;
  replyTo?: string | string[];
}

export async function sendEmail({
  to,
  subject,
  text,
  from = 'Elicita <noreply@elicita.es>',
  replyTo,
}: SendEmailArgs): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
  if (!resend) {
    console.error('[resend] RESEND_API_KEY no está configurada');
    return { ok: false, error: 'RESEND_API_KEY no configurada' };
  }

  try {
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject,
      text,
      reply_to: replyTo,
    });

    if (error || !data?.id) {
      const message = error?.message || 'Respuesta inesperada de Resend';
      console.error('[resend] Error enviando email:', message);
      return { ok: false, error: message };
    }

    return { ok: true, id: data.id };
  } catch (err: any) {
    console.error('[resend] Excepción enviando email:', err);
    return { ok: false, error: err?.message || 'Error desconocido' };
  }
}
