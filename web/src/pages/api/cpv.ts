import type { APIRoute } from 'astro';
import cpvData from '../../data/cpv_es.json';
import { rateLimitGuard } from '../../lib/rate-limit';

export const GET: APIRoute = async ({ request }) => {
  const limited = rateLimitGuard(request, { name: 'public-cpv', limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  return new Response(JSON.stringify(cpvData), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400, immutable', // 24h — CPV codes rarely change
      'Content-Encoding': 'gzip',
    }
  });
};
