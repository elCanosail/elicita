import type { APIRoute } from 'astro';
import { Resend } from 'resend';
import { rateLimitGuard } from '../../lib/rate-limit';
import { isContactType } from '../../lib/form-guard';

const resend = new Resend(import.meta.env.RESEND_API_KEY);
const TO = import.meta.env.RESEND_TO || 'contacto@elicita.es';

export const POST: APIRoute = async ({ request }) => {
  // Endpoint público de escritura que dispara email: rate limit por IP para no
  // quemar cuota de Resend ni inundar el buzon de contacto.
  const limited = rateLimitGuard(request, { name: 'contact', limit: 5, windowMs: 60_000 });
  if (limited) return limited;

  const data = await request.formData();
  const tipo = data.get('_tipo') as string;

  if (!isContactType(tipo)) {
    return new Response(JSON.stringify({ error: 'Tipo de formulario inválido' }), { status: 400 });
  }

  try {
    if (tipo === 'perfil') {
      // Formulario completo de perfil
      const campos = [
        ['Nombre', data.get('nombre')],
        ['Email', data.get('email')],
        ['Empresa', data.get('empresa')],
        ['Sectores', data.get('sectores')],
        ['CPVs', data.getAll('cpvs').join(', ') || '—'],
        ['Tamaño', data.get('tamanio') || '—'],
        ['Facturación', data.get('facturacion') || '—'],
        ['Objetivo', data.get('objetivo') || '—'],
        ['Horizonte', data.get('horizonte') || '—'],
        ['Comentarios', data.get('comentarios') || '—'],
      ];

      const html = `
        <h2 style="font-family:monospace;color:#10b981">Nuevo perfil preliminar — elicita_</h2>
        <table style="font-family:monospace;font-size:13px;border-collapse:collapse;width:100%">
          ${campos.map(([k, v]) => `
            <tr>
              <td style="color:#6b7280;padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top">${k}</td>
              <td style="color:#111827;padding:6px 0">${v}</td>
            </tr>
          `).join('')}
        </table>
      `;

      await resend.emails.send({
        from: 'elicita_ <noreply@elicita.es>',
        to: TO,
        subject: `Perfil preliminar — ${data.get('empresa')}`,
        html,
      });

    } else {
      // Consulta rápida
      const html = `
        <h2 style="font-family:monospace;color:#10b981">Consulta rápida — elicita_</h2>
        <table style="font-family:monospace;font-size:13px;border-collapse:collapse">
          <tr><td style="color:#6b7280;padding:6px 12px 6px 0">Nombre</td><td>${data.get('nombre_simple')}</td></tr>
          <tr><td style="color:#6b7280;padding:6px 12px 6px 0">Email</td><td>${data.get('email_simple')}</td></tr>
          <tr><td style="color:#6b7280;padding:6px 12px 6px 0">Empresa</td><td>${data.get('empresa_simple') || '—'}</td></tr>
          <tr><td style="color:#6b7280;padding:6px 12px 6px 0;vertical-align:top">Mensaje</td><td>${data.get('mensaje_simple')}</td></tr>
        </table>
      `;

      await resend.emails.send({
        from: 'elicita_ <noreply@elicita.es>',
        to: TO,
        subject: `Consulta — ${data.get('nombre_simple')}`,
        html,
      });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });

  } catch (err) {
    console.error('[resend]', err);
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
};
