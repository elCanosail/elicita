import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── OAuth 2.0 con Clerk como IdP + Dynamic Client Registration (RFC 7591) ──

interface OAuthClient {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name: string;
  created_at: number;
}

// Estado pendiente: mapea el state de Clerk al estado original del cliente MCP
interface PendingAuth {
  mcp_state: string;           // state original del cliente MCP
  mcp_client_id: string;       // client_id del cliente MCP (nuestro DCR)
  mcp_redirect_uri: string;    // redirect_uri del cliente MCP
  clerk_state: string;         // state que enviamos a Clerk
  created_at: number;
  expires_at: number;
}

interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  api_key: string;       // Elicita API key del usuario
  user_email: string;
  user_id: string;       // Clerk user ID
  created_at: number;
  expires_at: number;
}

interface AccessToken {
  token: string;
  client_id: string;
  api_key: string;
  user_email: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

// Stores en memoria
const clients = new Map<string, OAuthClient>();
const pendingAuths = new Map<string, PendingAuth>();
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, AccessToken>();

// Limpiar expirados cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuths.entries()) if (now > v.expires_at) pendingAuths.delete(k);
  for (const [k, v] of authCodes.entries()) if (now > v.expires_at) authCodes.delete(k);
  for (const [k, v] of accessTokens.entries()) if (now > v.expires_at) accessTokens.delete(k);
}, 5 * 60 * 1000).unref();

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutos
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

// Clerk OAuth config
const CLERK_ISSUER = process.env.CLERK_ISSUER || 'https://clerk.elicita.es';
const CLERK_CLIENT_ID = process.env.CLERK_OAUTH_CLIENT_ID || '';
const CLERK_CLIENT_SECRET = process.env.CLERK_OAUTH_CLIENT_SECRET || '';
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || '';
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL || 'https://elicita.es';
const MCP_CALLBACK_URL = `${MCP_PUBLIC_URL}/mcp/callback`;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const params: Record<string, string> = {};
      try {
        if (req.headers['content-type']?.includes('application/json')) {
          const j = JSON.parse(body);
          for (const [k, v] of Object.entries(j)) params[k] = String(v);
        } else {
          for (const pair of body.split('&')) {
            const [k, v] = pair.split('=').map(decodeURIComponent);
            if (k) params[k] = v || '';
          }
        }
      } catch { /* empty body */ }
      resolve(params);
    });
  });
}

export function isOAuthPath(pathname: string): boolean {
  return pathname.startsWith('/.well-known/oauth') ||
    pathname === '/authorize' ||
    pathname === '/token' ||
    pathname === '/register' ||
    pathname === '/mcp/callback';
}

export async function handleOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  baseUrl: string
): Promise<boolean> {

  // ── Discovery ──
  if (pathname === '/.well-known/oauth-authorization-server') {
    sendJson(res, 200, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      scopes_supported: ['read'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
    });
    return true;
  }

  // ── Dynamic Client Registration (RFC 7591) ──
  if (pathname === '/register' && req.method === 'POST') {
    const params = await readBody(req);

    // ⚠️ Validación de redirect_uris (RFC 7591 + OAuth best practices)
    // Solo localhost (desarrollo MCP local) o https (producción).
    const rawUris = params.redirect_uris ? String(params.redirect_uris).split(' ') : [];
        const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
    const validUris: string[] = [];
    for (const raw of rawUris) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: `redirect_uri no válida: ${raw}` });
        return true;
      }
      // Sin userinfo ni fragment
      if (u.username || u.password || u.hash) {
        sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uri con credenciales o fragment' });
        return true;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'solo http/https' });
        return true;
      }
      // http solo para localhost (dev MCP); https para cualquier host público
      if (u.protocol === 'http:' && !ALLOWED_HOSTS.has(u.hostname)) {
        sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'http solo para localhost' });
        return true;
      }
      validUris.push(u.toString());
    }
    if (validUris.length === 0) {
      sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'Se requiere al menos una redirect_uri' });
      return true;
    }

    const client_id = randomUUID();
    const client_secret = randomBytes(32).toString('hex');
    const client: OAuthClient = {
      client_id,
      client_secret,
      redirect_uris: validUris,
      client_name: params.client_name || 'unnamed',
      created_at: Date.now(),
    };
    clients.set(client_id, client);
    sendJson(res, 201, {
      client_id,
      client_secret,
      redirect_uris: client.redirect_uris,
      client_name: client.client_name,
      token_endpoint_auth_method: 'client_secret_post',
    });
    return true;
  }

  // ── Authorize — redirige a Clerk ──
  if (pathname === '/authorize') {
    const url = new URL(req.url || '', baseUrl);
    const client_id = url.searchParams.get('client_id') || '';
    const redirect_uri = url.searchParams.get('redirect_uri') || '';
    const state = url.searchParams.get('state') || '';
    const response_type = url.searchParams.get('response_type') || '';

    const client = clients.get(client_id);
    if (!client) {
      sendHtml(res, 400, `<h1>Error</h1><p>Client ID desconocido: ${client_id}</p>`);
      return true;
    }
    // ⚠️ Validar que redirect_uri coincide exactamente con una registrada (previene open redirects)
    if (!client.redirect_uris.includes(redirect_uri)) {
      sendHtml(res, 400, `<h1>Error</h1><p>redirect_uri no registrada para este client</p>`);
      return true;
    }
    if (response_type !== 'code') {
      sendHtml(res, 400, `<h1>Error</h1><p>response_type debe ser "code"</p>`);
      return true;
    }

    // Generar state para Clerk y guardar el estado del cliente MCP
    const clerk_state = randomBytes(16).toString('hex');
    pendingAuths.set(clerk_state, {
      mcp_state: state,
      mcp_client_id: client_id,
      mcp_redirect_uri: redirect_uri,
      clerk_state,
      created_at: Date.now(),
      expires_at: Date.now() + PENDING_AUTH_TTL_MS,
    });

    // Redirigir a Clerk OAuth
    const clerkAuthUrl = new URL(`${CLERK_ISSUER}/oauth/authorize`);
    clerkAuthUrl.searchParams.set('client_id', CLERK_CLIENT_ID);
    clerkAuthUrl.searchParams.set('redirect_uri', MCP_CALLBACK_URL);
    clerkAuthUrl.searchParams.set('response_type', 'code');
    clerkAuthUrl.searchParams.set('scope', 'email profile');
    clerkAuthUrl.searchParams.set('state', clerk_state);

    res.writeHead(302, { Location: clerkAuthUrl.toString() });
    res.end();
    return true;
  }

  // ── Callback de Clerk ──
  if (pathname === '/mcp/callback') {
    const url = new URL(req.url || '', baseUrl);
    const clerkCode = url.searchParams.get('code') || '';
    const clerkState = url.searchParams.get('state') || '';
    const error = url.searchParams.get('error') || '';

    if (error) {
      sendHtml(res, 400, renderErrorPage(error, url.searchParams.get('error_description') || ''));
      return true;
    }

    const pending = pendingAuths.get(clerkState);
    if (!pending) {
      sendHtml(res, 400, renderErrorPage('invalid_state', 'Estado de autorización inválido o expirado.'));
      return true;
    }
    pendingAuths.delete(clerkState);

    // Intercambiar code de Clerk por access token de Clerk
    let clerkToken: string;
    let userInfo: { sub: string; email: string; email_verified?: boolean };
    try {
      const tokenResp = await fetch(`${CLERK_ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: clerkCode,
          redirect_uri: MCP_CALLBACK_URL,
          client_id: CLERK_CLIENT_ID,
          client_secret: CLERK_CLIENT_SECRET,
        }),
      });

      if (!tokenResp.ok) {
        console.error('Clerk token exchange failed:', tokenResp.status);
        sendHtml(res, 500, renderErrorPage('token_exchange_failed', 'No se pudo obtener el token de Clerk.'));
        return true;
      }

      const tokenData = await tokenResp.json() as { access_token: string };
      clerkToken = tokenData.access_token;

      // Obtener userinfo de Clerk
      const userResp = await fetch(`${CLERK_ISSUER}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${clerkToken}` },
      });

      if (!userResp.ok) {
        sendHtml(res, 500, renderErrorPage('userinfo_failed', 'No se pudo obtener la información del usuario.'));
        return true;
      }

      userInfo = await userResp.json() as { sub: string; email: string };
    } catch (err) {
      console.error('Clerk OAuth error:', err);
      sendHtml(res, 500, renderErrorPage('clerk_error', 'Error comunicando con Clerk.'));
      return true;
    }

    // Buscar o crear API key de Elicita para este usuario
    const elicitaApiKey = await getOrCreateElicitaApiKey(userInfo.sub, userInfo.email);
    if (!elicitaApiKey) {
      sendHtml(res, 500, renderErrorPage('api_key_failed', 'No se pudo obtener la API key de Elicita.'));
      return true;
    }

    // Generar MCP authorization code
    const mcpCode = randomBytes(32).toString('hex');
    authCodes.set(mcpCode, {
      code: mcpCode,
      client_id: pending.mcp_client_id,
      redirect_uri: pending.mcp_redirect_uri,
      api_key: elicitaApiKey,
      user_email: userInfo.email,
      user_id: userInfo.sub,
      created_at: Date.now(),
      expires_at: Date.now() + AUTH_CODE_TTL_MS,
    });

    // Redirigir al callback original del cliente MCP
    const callbackUrl = new URL(pending.mcp_redirect_uri);
    callbackUrl.searchParams.set('code', mcpCode);
    if (pending.mcp_state) callbackUrl.searchParams.set('state', pending.mcp_state);

    res.writeHead(302, { Location: callbackUrl.toString() });
    res.end();
    return true;
  }

  // ── Token ──
  if (pathname === '/token' && req.method === 'POST') {
    const params = await readBody(req);
    const { grant_type, code, redirect_uri, client_id, client_secret } = params;

    if (grant_type === 'authorization_code') {
      const authCode = authCodes.get(code || '');
      if (!authCode) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'Authorization code inválido o expirado' });
        return true;
      }
      authCodes.delete(code!);

      if (authCode.client_id !== client_id) {
        sendJson(res, 400, { error: 'invalid_client' });
        return true;
      }

      const client = clients.get(client_id);
      if (!client || client.client_secret !== client_secret) {
        sendJson(res, 401, { error: 'invalid_client' });
        return true;
      }

      if (authCode.redirect_uri !== redirect_uri) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return true;
      }

      // Generar MCP access token
      const token = issueAccessToken({
        clientId: client_id,
        apiKey: authCode.api_key,
        userEmail: authCode.user_email,
        userId: authCode.user_id,
      });
      const refreshToken = randomBytes(32).toString('hex');

      sendJson(res, 200, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_MS / 1000,
        refresh_token: refreshToken,
        scope: 'read',
      });
      return true;
    }

    if (grant_type === 'refresh_token') {
      sendJson(res, 501, { error: 'unsupported_grant_type', error_description: 'Refresh token no implementado aún' });
      return true;
    }

    sendJson(res, 400, { error: 'unsupported_grant_type' });
    return true;
  }

  return false;
}

// ── Helper: buscar o crear API key de Elicita para un usuario Clerk ──
async function getOrCreateElicitaApiKey(userId: string, email: string): Promise<string | null> {
  try {
    // La API de Elicita tiene un endpoint interno para esto
    // O podemos llamar directamente a la API de keys
    const elicitaApiUrl = process.env.ELICITA_API_URL || 'http://localhost:4321';

    // Primero, listar las keys del usuario (requiere Clerk secret key)
    const listResp = await fetch(`${elicitaApiUrl}/api/v1/keys`, {
      headers: {
        Authorization: `Bearer ${CLERK_SECRET_KEY}`,
        'X-Clerk-User-Id': userId,
      },
    });

    if (listResp.ok) {
      
      // Si ya tiene una key llamada "MCP", usarla
      // Pero no podemos recuperar el valor completo de keys existentes (solo hash)
      // Así que necesitamos crear una nueva si no existe
    }

    // Crear una nueva API key para el MCP
    const createResp = await fetch(`${elicitaApiUrl}/api/v1/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CLERK_SECRET_KEY}`,
        'X-Clerk-User-Id': userId,
      },
      body: JSON.stringify({ name: `MCP OAuth (${email})` }),
    });

    if (!createResp.ok) {
      console.error('Failed to create API key:', createResp.status);
      return null;
    }

    const created = await createResp.json() as { key: string };
    return created.key;
  } catch (err) {
    console.error('Error creating Elicita API key:', err);
    return null;
  }
}

interface AccessTokenIdentity {
  clientId: string;
  apiKey: string;
  userEmail: string;
  userId: string;
}

// ── Helper: emitir y resolver access tokens MCP ──
export function issueAccessToken(identity: AccessTokenIdentity): string {
  const token = randomBytes(32).toString('hex');
  accessTokens.set(token, {
    token,
    client_id: identity.clientId,
    api_key: identity.apiKey,
    user_email: identity.userEmail,
    user_id: identity.userId,
    created_at: Date.now(),
    expires_at: Date.now() + ACCESS_TOKEN_TTL_MS,
  });
  return token;
}

export function resolveApiKey(accessToken: string): string | null {
  const token = accessTokens.get(accessToken);
  if (!token) return null;
  if (Date.now() > token.expires_at) {
    accessTokens.delete(accessToken);
    return null;
  }
  return token.api_key;
}

// ── HTML: página de error ──
function renderErrorPage(error: string, description: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elicita MCP — Error</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0e14; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
.card { background: #131822; border: 1px solid #1e2530; border-radius: 12px; padding: 2.5rem; max-width: 420px; width: 90%; text-align: center; }
h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; color: #e00; }
p { color: #8b95a5; font-size: 0.875rem; line-height: 1.5; }
</style>
</head>
<body>
<div class="card">
<h1>Error de autorización</h1>
<p>${description || error}</p>
<p style="margin-top: 1rem; font-size: 0.75rem; color: #6b7585;">Cierra esta ventana e inténtalo de nuevo.</p>
</div>
</body>
</html>`;
}