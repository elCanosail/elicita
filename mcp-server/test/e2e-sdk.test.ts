import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { createHttpServer as ServerFactory } from '../src/server.js';

const { createHttpServer } = await import(
  process.env.MCP_SMOKE_BUILD ? '../.verification-build/server.js' : '../src/server.js'
) as { createHttpServer: typeof ServerFactory };

// Synthetic fixtures. No real credentials, no production data.
const VALID_KEY = `elicita_live_${'a'.repeat(32)}_${'b'.repeat(48)}`;
const REVOKED_KEY = `elicita_live_${'c'.repeat(32)}_${'d'.repeat(48)}`;
const STABLE_TOOLS = ['search_licitaciones', 'get_stats', 'get_cobertura', 'search_cpv'];
const PUBLIC_TOOLS = ['get_stats', 'get_cobertura', 'search_cpv'];

interface BackendCall {
  path: string;
  query: Record<string, string>;
  credentialPresent: boolean;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
}

test('official SDK end-to-end: initialize/tools/list/search anon/auth/revoked/429, call counting and no fallback', async t => {
  const calls: BackendCall[] = [];

  const backend = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const credentialPresent = !!req.headers.authorization;
    calls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      credentialPresent,
    });
    res.setHeader('Content-Type', 'application/json');

    // Authenticated path only used when a direct API key is present.
    if (url.pathname === '/api/v1/search') {
      if (req.headers.authorization === `Bearer ${REVOKED_KEY}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'api_key_revoked' }));
        return;
      }
      if (url.searchParams.get('q') === 'quota') {
        res.writeHead(429);
        res.end(JSON.stringify({ error: 'Quota exceeded' }));
        return;
      }
      res.end(JSON.stringify({
        results: [{ id: 'auth-fixture', titulo: 'Contrato autenticado', importe_licitacion: 20 }],
        pagination: { limit: 1, offset: 0, has_more: false },
        meta: { total: 1 },
      }));
      return;
    }

    // Public path used by anonymous clients.
    if (url.pathname === '/api/public/search') {
      if (url.searchParams.get('q') === 'quota') {
        res.writeHead(429);
        res.end(JSON.stringify({ error: 'Quota exceeded' }));
        return;
      }
      res.end(JSON.stringify({
        results: [{ id: 'anon-fixture', titulo: 'Contrato público', importe_licitacion: 10 }],
        pagination: { limit: 1, offset: 0, has_more: false },
        meta: { total: 1 },
      }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  const apiBaseUrl = await listen(backend);
  const server = createHttpServer({ apiBaseUrl });
  const base = await listen(server);

  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await close(server);
    await close(backend);
  });

  async function connect(bearer?: string): Promise<Client> {
    const client = new Client({ name: 'e2e-sdk', version: '1.0.0' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: {
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          },
        },
      })
    );
    return client;
  }

  // 1. initialize (connect) + tools/list do NOT consume any backend search quota.
  const anonymous = await connect();
  const serverInfo = anonymous.getServerVersion();
  assert.equal(serverInfo?.name, 'elicita-mcp-server');
  assert.equal(serverInfo?.version, '1.0.0');
  assert.deepEqual((await anonymous.listTools()).tools.map(x => x.name), PUBLIC_TOOLS);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual((await anonymous.listTools()).tools.map(x => x.name), PUBLIC_TOOLS);
  }
  assert.equal(calls.length, 0, 'initialize/listTools must not reach the search API');

  // 2. Anonymous discovery cannot call contract search or reach the backend.
  const anonymousSearch = await anonymous.callTool({
    name: 'search_licitaciones',
    arguments: { q: 'fixture', limit: 1 },
  });
  assert.equal(anonymousSearch.isError, true);
  assert.equal(calls.length, 0);

  // 3. Valid mock key: routes to authenticated /api/v1/search with credential present.
  const authenticated = await connect(VALID_KEY);
  assert.deepEqual((await authenticated.listTools()).tools.map(x => x.name), STABLE_TOOLS);
  const authResult = await authenticated.callTool({
    name: 'search_licitaciones',
    arguments: { q: 'fixture', limit: 1 },
  });
  assert.ok(!authResult.isError);
  const lastAuthCall = calls.at(-1)!;
  assert.equal(lastAuthCall.path, '/api/v1/search');
  assert.equal(lastAuthCall.credentialPresent, true);

  // 4. Invalid-format Bearer: SDK connect is rejected with HTTP 401; no anonymous fallback.
  const beforeInvalid = calls.length;
  await assert.rejects(() => connect('not-a-valid-key'), (err: unknown) => {
    const code = (err as { code?: number }).code;
    assert.equal(code, 401, 'SDK must surface the HTTP 401 for a malformed credential');
    return true;
  });
  assert.equal(calls.length, beforeInvalid, 'no backend call may be made for an invalid credential');

  // 5. Well-formed but revoked key: backend returns 401 -> isError, and no anonymous fallback.
  const beforeRevoked = calls.length;
  const revoked = await connect(REVOKED_KEY);
  const revokedResult = await revoked.callTool({
    name: 'search_licitaciones',
    arguments: { q: 'fixture' },
  });
  assert.equal(revokedResult.isError, true);
  assert.match(JSON.stringify(revokedResult.content), /401/);
  assert.equal(calls.length, beforeRevoked + 1);
  assert.equal(calls.at(-1)?.path, '/api/v1/search');
  assert.equal(calls.at(-1)?.credentialPresent, true);
  // No NEW public-search call after the revoked attempt (calls before beforeRevoked were anonymous by design).
  assert.ok(!calls.slice(beforeRevoked).some(c => c.path === '/api/public/search'), 'no anonymous fallback after a revoked key');

  // 7. No credential is ever echoed in tool output.
  const allOutput = [
    JSON.stringify(authResult),
    JSON.stringify(revokedResult),
  ].join(' ');
  assert.ok(!allOutput.includes(VALID_KEY) && !allOutput.includes(REVOKED_KEY));
});
