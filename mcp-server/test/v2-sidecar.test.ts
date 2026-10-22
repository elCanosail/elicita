import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { createHttpServer } from '../src/server.js';
import { createV2HttpServer } from '../src/v2/server.js';
import { createV2SidecarHandler, type V2SidecarHandler } from '../src/v2/sidecar.js';

const VALID_KEY = `elicita_live_${'a'.repeat(32)}_${'b'.repeat(48)}`;
const SNAPSHOT_DIR = fileURLToPath(new URL('./fixtures/market-intelligence/approved', import.meta.url));
const REAL_CATALOG = [
  'search_licitaciones',
  'get_stats',
  'get_cobertura',
  'search_cpv',
  'market_snapshot',
  'rank_companies',
  'analyze_buyer',
  'trace_metric',
];
const PUBLIC_CATALOG = REAL_CATALOG.slice(1);

interface BackendCall {
  path: string;
  query: Record<string, string>;
  authorization?: string;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function createBackend(calls: BackendCall[]): Server {
  return createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://backend.invalid');
    calls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/stats') {
      res.end(JSON.stringify({ totalHistorical: 12, fuentes: [{ nombre: 'PLACSP', count: 12 }], lastUpdate: '2026-09-14T00:00:00Z' }));
      return;
    }
    if (url.pathname === '/api/cobertura') {
      res.end(JSON.stringify({ total: 1, globalLastRun: '2026-09-14T00:00:00Z', fuentes: [{ nombre: 'PLACSP', lastUpdate: '2026-09-13T00:00:00Z' }] }));
      return;
    }
    if (url.pathname === '/api/v1/search') {
      res.end(JSON.stringify({
        results: [{ id: 'fixture-1', titulo: 'Contrato fixture', importe_licitacion: 42 }],
        pagination: { limit: 1, offset: 0, has_more: false },
        meta: { total: 1 },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}

function sidecarFetch(handler: V2SidecarHandler, bearer?: string): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set('Host', 'test.local');
    if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
    const authenticatedRequest = new Request(request, { headers });
    if (bearer) assert.equal(authenticatedRequest.headers.get('authorization'), `Bearer ${bearer}`);
    return handler.fetch(authenticatedRequest);
  };
}

function modernTransport(fetcher: typeof fetch, bearer?: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL('http://test.local/mcp-v2'), {
    fetch: fetcher,
    ...(bearer ? { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } } : {}),
  });
}

function comparable(result: unknown): unknown {
  const value = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  assert.ok(value.content, 'tool call must return a complete tool result');
  return {
    content: value.content,
    structuredContent: value.structuredContent,
    isError: value.isError ?? false,
  };
}

function comparableCatalog(tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): unknown {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: withoutDatasetParam(withoutSchemaDialect(tool.inputSchema)),
  }));
}

// The two protocol-era SDKs render the multi-dataset parameter differently in
// JSON Schema (the legacy SDK drops enum-with-default fields behind optional
// wrappers). Dispatch validates the dataset with zod on both sides, so tool
// semantics are equivalent; the catalog comparison ignores that rendering.
function withoutDatasetParam(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const { properties, ...rest } = schema as Record<string, unknown>;
  if (!properties || typeof properties !== 'object') return schema;
  const { dataset: _dropped, ...restProperties } = properties as Record<string, unknown>;
  return { ...rest, ...(Object.keys(restProperties).length > 0 ? { properties: restProperties } : {}) };
}

function withoutSchemaDialect(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSchemaDialect);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== '$schema')
      .map(([key, nested]) => [key, withoutSchemaDialect(nested)]),
  );
}

function rawPost(base: string, path: string, body: string): Promise<{ status: number; body: string }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: 'POST',
      headers: {
        Host: 'test.local',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: response }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('v2 sidecar preserves the real catalog and v1 results for legacy and 2026-07-28 clients', async t => {
  const calls: BackendCall[] = [];
  const backend = createBackend(calls);
  const apiBaseUrl = await listen(backend);
  const oldSnapshot = process.env.ELICITA_APPROVED_SNAPSHOT_DIR;
  process.env.ELICITA_APPROVED_SNAPSHOT_DIR = SNAPSHOT_DIR;
  const v1Server = createHttpServer({ apiBaseUrl });
  const v1Base = await listen(v1Server);
  const sidecar = createV2SidecarHandler({
    apiBaseUrl,
    approvedSnapshotConfigs: { technology: { approvedSnapshotDir: SNAPSHOT_DIR } },
    allowedHosts: ['test.local'],
    allowedOrigins: ['test.local'],
  });
  const v1Clients: LegacyClient[] = [];
  const v2Clients: Client[] = [];
  t.after(async () => {
    for (const client of v1Clients) await client.close().catch(() => {});
    for (const client of v2Clients) await client.close().catch(() => {});
    await sidecar.close();
    await close(v1Server);
    await close(backend);
    if (oldSnapshot === undefined) delete process.env.ELICITA_APPROVED_SNAPSHOT_DIR;
    else process.env.ELICITA_APPROVED_SNAPSHOT_DIR = oldSnapshot;
  });

  const v1 = new LegacyClient({ name: 'v1-equivalence', version: '1.0.0' });
  v1Clients.push(v1);
  await v1.connect(new LegacyTransport(new URL(`${v1Base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${VALID_KEY}` } },
  }));
  const legacy = new Client({ name: 'v2-legacy-equivalence', version: '1.0.0' });
  v2Clients.push(legacy);
  await legacy.connect(modernTransport(sidecarFetch(sidecar, VALID_KEY), VALID_KEY));
  assert.equal(legacy.getProtocolEra(), 'legacy');
  const modern = new Client(
    { name: 'v2-modern-equivalence', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  v2Clients.push(modern);
  await modern.connect(modernTransport(sidecarFetch(sidecar, VALID_KEY), VALID_KEY));
  assert.equal(modern.getProtocolEra(), 'modern');

  const v1Tools = await v1.listTools();
  const legacyTools = await legacy.listTools();
  const modernTools = await modern.listTools();
  assert.deepEqual(v1Tools.tools.map(tool => tool.name), REAL_CATALOG);
  assert.deepEqual(legacyTools.tools.map(tool => tool.name), REAL_CATALOG);
  assert.deepEqual(modernTools.tools.map(tool => tool.name), REAL_CATALOG);
  assert.deepEqual(comparableCatalog(legacyTools.tools), comparableCatalog(v1Tools.tools));
  assert.deepEqual(comparableCatalog(modernTools.tools), comparableCatalog(v1Tools.tools));
  assert.equal(calls.length, 0, 'catalog discovery must not consume upstream quota');

  const [v1Stats, legacyStats, modernStats] = await Promise.all([
    v1.callTool({ name: 'get_stats', arguments: {} }),
    legacy.callTool({ name: 'get_stats', arguments: {} }),
    modern.callTool({ name: 'get_stats', arguments: {} }),
  ]);
  assert.deepEqual(comparable(legacyStats), comparable(v1Stats));
  assert.deepEqual(comparable(modernStats), comparable(v1Stats));

  const [v1Snapshot, legacySnapshot, modernSnapshot] = await Promise.all([
    v1.callTool({ name: 'market_snapshot', arguments: {} }),
    legacy.callTool({ name: 'market_snapshot', arguments: {} }),
    modern.callTool({ name: 'market_snapshot', arguments: {} }),
  ]);
  assert.deepEqual(comparable(legacySnapshot), comparable(v1Snapshot));
  assert.deepEqual(comparable(modernSnapshot), comparable(v1Snapshot));

  const v1Search = await v1.callTool({ name: 'search_licitaciones', arguments: { q: 'fixture', limit: 1 } });
  const legacySearch = await legacy.callTool({ name: 'search_licitaciones', arguments: { q: 'fixture', limit: 1 } });
  const modernSearch = await modern.callTool({ name: 'search_licitaciones', arguments: { q: 'fixture', limit: 1 } });
  assert.deepEqual(comparable(legacySearch), comparable(v1Search));
  assert.deepEqual(comparable(modernSearch), comparable(v1Search));
  assert.equal(calls.filter(call => call.path === '/api/v1/search').length, 3);
  assert.ok(calls.filter(call => call.path === '/api/v1/search').every(call => call.authorization === `Bearer ${VALID_KEY}`));

  const anonymous = new Client({ name: 'v2-public-catalog', version: '1.0.0' });
  v2Clients.push(anonymous);
  await anonymous.connect(modernTransport(sidecarFetch(sidecar)));
  assert.deepEqual((await anonymous.listTools()).tools.map(tool => tool.name), PUBLIC_CATALOG);
  await assert.rejects(() => anonymous.callTool({ name: 'search_licitaciones', arguments: { q: 'fixture' } }));
  assert.equal(calls.filter(call => call.path === '/api/v1/search').length, 3, 'anonymous search must not reach upstream');
});

test('v2 sidecar rejects invalid credentials and untrusted Host/Origin before protocol dispatch', async t => {
  const calls: BackendCall[] = [];
  const backend = createBackend(calls);
  const apiBaseUrl = await listen(backend);
  const sidecar = createV2SidecarHandler({
    apiBaseUrl,
    allowedHosts: ['test.local'],
    allowedOrigins: ['test.local'],
  });
  const anonymous = new Client({ name: 'v2-no-snapshot', version: '1.0.0' });
  t.after(async () => { await anonymous.close().catch(() => {}); await sidecar.close(); await close(backend); });
  await anonymous.connect(modernTransport(sidecarFetch(sidecar)));
  assert.deepEqual((await anonymous.listTools()).tools.map(tool => tool.name), ['get_stats', 'get_cobertura', 'search_cpv']);

  const invalid = await sidecar.fetch(new Request('http://test.local/mcp-v2', {
    method: 'POST',
    headers: { Host: 'test.local', Authorization: 'Bearer not-an-api-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
  }));
  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { error: 'unauthorized' });

  const evilHost = await sidecar.fetch(new Request('http://evil.example/mcp-v2', {
    method: 'POST',
    headers: { Host: 'evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
  }));
  assert.equal(evilHost.status, 403);

  const evilOrigin = await sidecar.fetch(new Request('http://test.local/mcp-v2', {
    method: 'POST',
    headers: { Host: 'test.local', Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
  }));
  assert.equal(evilOrigin.status, 403);
  assert.equal(calls.length, 0);
});

test('v2 node sidecar keeps the v1 64 KiB body bound and exposes independent health', async t => {
  const calls: BackendCall[] = [];
  const backend = createBackend(calls);
  const apiBaseUrl = await listen(backend);
  const sidecar = createV2HttpServer({
    apiBaseUrl,
    allowedHosts: ['test.local'],
    allowedOrigins: ['test.local'],
  });
  const base = await listen(sidecar);
  t.after(async () => { await close(sidecar); await close(backend); });

  const tooLarge = await rawPost(base, '/mcp-v2', JSON.stringify({ q: 'x'.repeat(70 * 1024) }));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(JSON.parse(tooLarge.body), { error: 'body_too_large' });
  const health = await fetch(`${base}/health`);
  assert.deepEqual(await health.json(), { status: 'ok', version: '2.0.0', transport: 'streamable-http' });
  assert.equal(calls.length, 0);
});
