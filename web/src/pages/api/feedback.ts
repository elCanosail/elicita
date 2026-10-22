import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import fs from 'fs';
import path from 'path';
import { rateLimitGuard } from '../../lib/rate-limit';
import { FEEDBACK_MESSAGE_MAX, feedbackFilename, normalizeFeedbackType } from '../../lib/form-guard';

// Freshdesk — set these when account is ready
const FD_DOMAIN = import.meta.env.FRESHDESK_DOMAIN || ''; // e.g. 'elicita.freshdesk.com'
const FD_API_KEY = import.meta.env.FRESHDESK_API_KEY || '';

const FEEDBACK_DIR = path.resolve(process.cwd(), '..', 'data', 'feedback');

export const POST: APIRoute = async ({ request, locals }) => {
  // Endpoint público de escritura: rate limit por IP antes de tocar disco/email.
  const limited = rateLimitGuard(request, { name: 'feedback', limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = await request.json();
    const { message } = body;
    // Allowlist: el tipo entra en el nombre de fichero; un valor hostil no debe
    // poder escapar del directorio (path traversal).
    const type = normalizeFeedbackType(body.type);

    if (!message?.trim()) {
      return new Response(JSON.stringify({ error: 'Mensaje requerido' }), { status: 400 });
    }
    if (String(message).length > FEEDBACK_MESSAGE_MAX) {
      return new Response(JSON.stringify({ error: 'Mensaje demasiado largo' }), { status: 400 });
    }

    // Resolve user from Clerk
    const auth = (locals as any).auth?.();
    const userId = auth?.userId || 'anonymous';

    let userName = userId;
    let userEmail = 'feedback@elicita.es';

    if (userId !== 'anonymous') {
      try {
        const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
        const user = await client.users.getUser(userId);
        userName = user.username || user.firstName || userId;
        userEmail = user.emailAddresses?.[0]?.emailAddress || userEmail;
      } catch {}
    }

    const typeLabels: Record<string, string> = {
      bug: '🐛 Bug',
      idea: '💡 Idea',
      otro: '💬 Otro',
    };

    const subject = `[Feedback] ${typeLabels[type] || type} — ${userName}`;

    // Try Freshdesk first
    if (FD_DOMAIN && FD_API_KEY) {
      const res = await fetch(`https://${FD_DOMAIN}/api/v2/tickets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${FD_API_KEY}:X`).toString('base64'),
        },
        body: JSON.stringify({
          name: userName,
          email: userEmail,
          subject,
          description: `Tipo: ${typeLabels[type] || type}\nUsuario: ${userName} (${userEmail})\n\n${message}`,
          priority: type === 'bug' ? 3 : 1,
          status: 2,
          tags: ['feedback', type, 'in-app'],
        }),
      });

      if (!res.ok) {
        console.error('[feedback] Freshdesk error:', res.status, await res.text());
        // Fall through to local storage
      } else {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }

    // Fallback: store locally as JSON
    fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      type,
      user: userName,
      email: userEmail,
      userId,
      message: message.trim(),
    };
    const filename = feedbackFilename(type);
    fs.writeFileSync(path.join(FEEDBACK_DIR, filename), JSON.stringify(entry, null, 2));

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e: any) {
    console.error('[feedback] Error:', e.message);
    return new Response(JSON.stringify({ error: 'Error interno' }), { status: 500 });
  }
};
