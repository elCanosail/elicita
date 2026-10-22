import type { APIRoute } from 'astro';
import fs from 'fs';
import path from 'path';
import { rateLimitGuard } from '../../lib/rate-limit';
import { WAITLIST_MAX_ENTRIES, isValidEmail } from '../../lib/form-guard';

const WAITLIST_FILE = '/var/data/elicita/waitlist.json';

export const POST: APIRoute = async ({ request }) => {
  // Endpoint público de escritura: rate limit por IP (la lista se reescribe
  // completa en cada alta → O(n) sin freno).
  const limited = rateLimitGuard(request, { name: 'waitlist', limit: 5, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const { email } = await request.json();
    if (!isValidEmail(email)) {
      return new Response(JSON.stringify({ error: 'Email inválido' }), { status: 400 });
    }

    const dir = path.dirname(WAITLIST_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let list: string[] = [];
    if (fs.existsSync(WAITLIST_FILE)) {
      try { list = JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf-8')); } catch(_) {}
    }

    const normalized = String(email).toLowerCase().trim();
    if (!list.includes(normalized)) {
      if (list.length >= WAITLIST_MAX_ENTRIES) {
        return new Response(JSON.stringify({ error: 'Lista de espera llena' }), { status: 503 });
      }
      list.push(normalized);
      fs.writeFileSync(WAITLIST_FILE, JSON.stringify(list, null, 2));
    }

    return new Response(JSON.stringify({ ok: true, total: list.length }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Error interno' }), { status: 500 });
  }
};
