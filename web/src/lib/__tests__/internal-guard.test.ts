import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adminGuard,
  extractProvidedKey,
  getAdminKey,
  isAuthorizedAdmin,
  isDevelopment,
} from '../internal-guard';

const ORIG = {
  apiKey: process.env.ADMIN_API_KEY,
  secret: process.env.ADMIN_SECRET,
  nodeEnv: process.env.NODE_ENV,
};

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://elicita.example/api/reload', { method: 'POST', headers });
}

beforeEach(() => {
  delete process.env.ADMIN_API_KEY;
  delete process.env.ADMIN_SECRET;
  process.env.NODE_ENV = 'production';
});

afterEach(() => {
  for (const [key, value] of [
    ['ADMIN_API_KEY', ORIG.apiKey],
    ['ADMIN_SECRET', ORIG.secret],
    ['NODE_ENV', ORIG.nodeEnv],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('getAdminKey', () => {
  it('sin secretos definidos devuelve cadena vacía', () => {
    expect(getAdminKey()).toBe('');
  });

  it('prefiere ADMIN_API_KEY y cae a ADMIN_SECRET', () => {
    process.env.ADMIN_SECRET = 'secundario';
    expect(getAdminKey()).toBe('secundario');
    process.env.ADMIN_API_KEY = 'principal';
    expect(getAdminKey()).toBe('principal');
  });
});

describe('extractProvidedKey', () => {
  it('lee Authorization: Bearer (case-insensitive)', () => {
    expect(extractProvidedKey(req({ authorization: 'bearer tok123' }))).toBe('tok123');
  });

  it('lee X-Admin-Key como alternativa', () => {
    expect(extractProvidedKey(req({ 'x-admin-key': 'tok456' }))).toBe('tok456');
  });

  it('sin cabeceras devuelve cadena vacía', () => {
    expect(extractProvidedKey(req())).toBe('');
  });
});

describe('isAuthorizedAdmin / adminGuard (fail-closed)', () => {
  it('sin secreto configurado deniega aunque la petición traiga uno', () => {
    expect(isAuthorizedAdmin(req({ authorization: 'Bearer loquesea' }))).toBe(false);
    expect(adminGuard(req({ authorization: 'Bearer loquesea' }))!.status).toBe(403);
  });

  it('con secreto configurado autoriza Bearer correcto', () => {
    process.env.ADMIN_API_KEY = 'secreto-fuerte';
    expect(isAuthorizedAdmin(req({ authorization: 'Bearer secreto-fuerte' }))).toBe(true);
    expect(adminGuard(req({ authorization: 'Bearer secreto-fuerte' }))).toBeNull();
  });

  it('con secreto configurado autoriza X-Admin-Key correcto', () => {
    process.env.ADMIN_API_KEY = 'secreto-fuerte';
    expect(adminGuard(req({ 'x-admin-key': 'secreto-fuerte' }))).toBeNull();
  });

  it('rechaza secreto incorrecto con 403 y code admin_required', async () => {
    process.env.ADMIN_API_KEY = 'secreto-fuerte';
    const res = adminGuard(req({ authorization: 'Bearer corto' }))!;
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect((await res.json()).code).toBe('admin_required');
  });

  it('rechaza peticiones sin cabecera con 403', () => {
    process.env.ADMIN_API_KEY = 'secreto-fuerte';
    expect(adminGuard(req())!.status).toBe(403);
  });

  it('ADMIN_SECRET habilita el guard como respaldo', () => {
    process.env.ADMIN_SECRET = 'compartido';
    expect(adminGuard(req({ authorization: 'Bearer compartido' }))).toBeNull();
  });
});

describe('isDevelopment', () => {
  it('true solo con NODE_ENV=development', () => {
    process.env.NODE_ENV = 'development';
    expect(isDevelopment()).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(isDevelopment()).toBe(false);
    delete process.env.NODE_ENV;
    expect(isDevelopment()).toBe(false);
  });
});
