import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MARKET_INTELLIGENCE_TOOL_NAMES } from '../src/tools/market-intelligence.js';
import type { createHttpServer as ServerFactory } from '../src/server.js';
const buildUnderTest = process.env.MCP_SMOKE_BUILD ? '../.verification-build' : '../src';
const { createHttpServer, EXPERIMENTAL_TOOL_NAMES } = await import(`${buildUnderTest}/server.js`) as { createHttpServer: typeof ServerFactory; EXPERIMENTAL_TOOL_NAMES: readonly string[] };
const metrics = await import(`${buildUnderTest}/lib/metrics.js`) as typeof import('../src/lib/metrics.js');
const syntheticKey = () => `elicita_live_${'a'.repeat(32)}_${'b'.repeat(48)}`;
const stable = ['search_licitaciones', 'get_stats', 'get_cobertura', 'search_cpv'];
  const publicTools = ['get_stats', 'get_cobertura', 'search_cpv'];
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
}

test('local HTTP smoke: initialization, registry, calls, health, invalid credential and backend quotas', async t => {
  metrics.reset();
  const oldFlag = process.env.MCP_ENABLE_EXPERIMENTAL_TOOLS;
  process.env.MCP_ENABLE_EXPERIMENTAL_TOOLS = 'true';
  const forwardedIps: unknown[] = [];
  const calls: Array<{ path: string; query: Record<string, string>; credentialPresent: boolean }> = [];
  const backend = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    forwardedIps.push(req.headers['x-forwarded-for']);
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), credentialPresent: !!req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v1/search') {
      res.writeHead(401); res.end(JSON.stringify({ error: 'private-upstream-detail' })); return;
    }
    if (url.searchParams.get('q') === 'quota') {
      res.writeHead(429); res.end(JSON.stringify({ error: 'Quota exceeded' })); return;
    }
    res.end(JSON.stringify({ results: [{ id: 'fixture', titulo: 'Contrato de prueba', importe_licitacion: 10 }], pagination: { limit: 1, offset: 0, has_more: false }, meta: { total: 1 } }));
  });
  const apiBaseUrl = await listen(backend);
  const server = createHttpServer({ apiBaseUrl });
  const base = await listen(server);
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await close(server); await close(backend);
    if (oldFlag === undefined) delete process.env.MCP_ENABLE_EXPERIMENTAL_TOOLS;
    else process.env.MCP_ENABLE_EXPERIMENTAL_TOOLS = oldFlag;
  });
  async function connect(bearer?: string): Promise<Client> {
    const client = new Client({ name: 'local-smoke', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { 'CF-Connecting-IP': '198.51.100.1', 'X-Forwarded-For': '198.51.100.2', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } }
    }));
    return client;
  }
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', version: '1.0.0', transport: 'streamable-http' });
  const anonymous = await connect();
  // More than three protocol calls must not consume search quota.
  for (let i = 0; i < 5; i++) assert.deepEqual((await anonymous.listTools()).tools.map(x => x.name), publicTools);
  assert.equal(calls.length, 0);
  const anonymousSearch = await anonymous.callTool({ name: 'search_licitaciones', arguments: { q: 'fixture' } });
  assert.equal(anonymousSearch.isError, true);
  assert.equal(calls.length, 0);
  const fake = await connect(syntheticKey());
  assert.deepEqual((await fake.listTools()).tools.map(x => x.name), stable);
  const registeredNames = (await fake.listTools()).tools.map(tool => tool.name);
  for (const name of MARKET_INTELLIGENCE_TOOL_NAMES) assert.ok(!registeredNames.includes(name));
  for (const name of EXPERIMENTAL_TOOL_NAMES) {
    const blocked = await fake.callTool({ name, arguments: {} });
    assert.equal(blocked.isError, true);
  }
  const before = calls.length;
  const rejected = await fake.callTool({ name: 'search_licitaciones', arguments: { q: 'fixture' } });
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected.content), /401/);
  assert.ok(!JSON.stringify(rejected).includes('private-upstream-detail'));
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1)?.path, '/api/v1/search');
  assert.equal(calls.at(-1)?.credentialPresent, true);
  const invalid = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer unknown' } });
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get('x-request-id') || '', /^[0-9a-f]{16}$/);
  assert.deepEqual(await invalid.json(), { error: 'unauthorized' });
  assert.equal((await fetch(`${base}/.well-known/oauth-unknown`)).status, 404);
  const cpv = await anonymous.callTool({ name: 'search_cpv', arguments: { q: 'software', limit: 1 } });
  assert.ok(!cpv.isError);
});
