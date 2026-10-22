import { describe, expect, it } from 'vitest';
import { checkRateLimit, rateLimitGuard, getClientIp } from '../rate-limit';

function req(ip = '1.2.3.4'): Request {
  return new Request('https://elicita.example/api/test', {
    headers: ip ? { 'cf-connecting-ip': ip } : {},
  });
}

describe('checkRateLimit (bucket compartido de endpoints públicos)', () => {
  it('primera petición permitida con remaining = limit - 1', () => {
    const r = checkRateLimit(req(), { name: 'test-primera', limit: 5, windowMs: 60_000 });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
  });

  it('agota el límite y bloquea la petición siguiente', () => {
    const name = 'test-agota';
    const opts = { name, limit: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(req(), opts).allowed).toBe(true);
    }
    const blocked = checkRateLimit(req(), opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('aisla por IP', () => {
    const opts = { name: 'test-ips', limit: 1, windowMs: 60_000 };
    expect(checkRateLimit(req('9.9.9.1'), opts).allowed).toBe(true);
    expect(checkRateLimit(req('9.9.9.1'), opts).allowed).toBe(false);
    expect(checkRateLimit(req('9.9.9.2'), opts).allowed).toBe(true);
  });

  it('aisla por nombre de endpoint', () => {
    expect(checkRateLimit(req('8.8.8.8'), { name: 'test-ep-a', limit: 1, windowMs: 60_000 }).allowed).toBe(true);
    expect(checkRateLimit(req('8.8.8.8'), { name: 'test-ep-a', limit: 1, windowMs: 60_000 }).allowed).toBe(false);
    expect(checkRateLimit(req('8.8.8.8'), { name: 'test-ep-b', limit: 1, windowMs: 60_000 }).allowed).toBe(true);
  });

  it('resetTime cae en el borde de la ventana siguiente (UTC, alineado a época)', () => {
    const windowMs = 60_000;
    const r = checkRateLimit(req(), { name: 'test-reset', limit: 5, windowMs });
    const now = Date.now();
    expect(r.resetTime * 1000).toBeGreaterThan(now);
    expect((r.resetTime * 1000) % windowMs).toBe(0);
    expect(r.resetTime * 1000 - now).toBeLessThanOrEqual(windowMs);
  });

  it('ventana de día alineada a medianoche UTC (semántica de search.ts)', () => {
    const r = checkRateLimit(req(), { name: 'test-dia', limit: 3, windowMs: 86_400_000 });
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    expect(r.resetTime).toBe(midnight.getTime() / 1000 + 86_400);
  });
});

describe('getClientIp', () => {
  it('prioriza CF-Connecting-IP sobre x-real-ip', () => {
    const r = new Request('https://x.example', {
      headers: { 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '2.2.2.2' },
    });
    expect(getClientIp(r)).toBe('1.1.1.1');
  });

  it('cae a x-real-ip y luego a XFF', () => {
    expect(getClientIp(new Request('https://x', { headers: { 'x-real-ip': '2.2.2.2' } }))).toBe('2.2.2.2');
    expect(getClientIp(new Request('https://x', { headers: { 'x-forwarded-for': '3.3.3.3, 4.4.4.4' } }))).toBe('3.3.3.3');
    expect(getClientIp(new Request('https://x'))).toBe('unknown');
  });
});

describe('rateLimitGuard', () => {
  it('devuelve null si la petición puede continuar', () => {
    expect(rateLimitGuard(req('7.7.7.7'), { name: 'test-guard-ok', limit: 5, windowMs: 60_000 })).toBeNull();
  });

  it('devuelve 429 con Retry-After y cabeceras X-RateLimit cuando se agota', () => {
    const opts = { name: 'test-guard-429', limit: 1, windowMs: 60_000 };
    expect(rateLimitGuard(req('6.6.6.6'), opts)).toBeNull();
    const res = rateLimitGuard(req('6.6.6.6'), opts);
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(429);
    expect(Number(res!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(res!.headers.get('x-ratelimit-limit')).toBe('1');
    expect(res!.headers.get('x-ratelimit-remaining')).toBe('0');
    const body = JSON.parse(res!.headers.get('content-type') === 'application/json' ? '{}' : '{}');
    void body; // el parseo del cuerpo se hace vía res.json() abajo
    expect(res!.headers.get('content-type')).toBe('application/json');
  });

  it('el cuerpo del 429 informa code y retry_after_seconds', async () => {
    const opts = { name: 'test-guard-body', limit: 1, windowMs: 60_000 };
    rateLimitGuard(req('5.5.5.5'), opts);
    const res = rateLimitGuard(req('5.5.5.5'), opts)!;
    const body = await res.json();
    expect(body.code).toBe('rate_limit_exceeded');
    expect(body.retry_after_seconds).toBeGreaterThanOrEqual(1);
  });
});
