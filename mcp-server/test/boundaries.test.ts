import assert from 'node:assert/strict';
import { request, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type * as ServerModule from '../src/server.js';
import type * as StatsModule from '../src/tools/stats.js';
const { formatStats } = await import(process.env.MCP_SMOKE_BUILD ? '../.verification-build/tools/stats.js' : '../src/tools/stats.js') as typeof StatsModule;
import type * as CoverageModule from '../src/tools/cobertura.js';
const { formatCobertura } = await import(process.env.MCP_SMOKE_BUILD ? '../.verification-build/tools/cobertura.js' : '../src/tools/cobertura.js') as typeof CoverageModule;
const { createHttpServer, getClientIp } = await import(process.env.MCP_SMOKE_BUILD ? '../.verification-build/server.js' : '../src/server.js') as typeof ServerModule;

test('IP trust is restricted to X-Real-IP from loopback', () => {
  function ip(peer: string, headers: IncomingMessage['headers']): string {
    return getClientIp({ socket: { remoteAddress: peer }, headers } as IncomingMessage);
  }
  const spoof = { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2' };
  assert.equal(ip('127.0.0.1', spoof), '127.0.0.1');
  assert.equal(ip('203.0.113.3', { ...spoof, 'x-real-ip': '198.51.100.4' }), '203.0.113.3');
  assert.equal(ip('127.0.0.1', { ...spoof, 'x-real-ip': '198.51.100.4' }), '198.51.100.4');
  assert.equal(ip('::1', { 'x-real-ip': 'not-an-ip' }), '::1');
});

// Synthetic fixtures following web/src/pages/api/{stats,cobertura}.ts, not production data.
test('stats uses historical universe and ingestion freshness, never generatedAt or sums', () => {
  const text = formatStats({ totalHistorical: 42, totalBorme: 999, totalRT: 888,
    pipeline: [], sources: [{ name: 'Fixture', count: 42 }], lastUpdate: '2026-01-01', generatedAt: '2099-12-31' });
  assert.match(text, /históricos \(no contratos únicos\):\*\* 42/);
  assert.match(text, /2026-01-01/);
  assert.ok(!text.includes('2099') && !text.includes('999') && !text.includes('888'));
  assert.ok(!formatStats({ totalHistorical: 0, lastUpdate: '', generatedAt: '2099' }).includes('2099'));
});

test('coverage separates global pipeline run from each source freshness', () => {
  const text = formatCobertura({ totalRecords: 999, globalLastRun: '2026-02-02', generatedAt: '2099',
    fuentes: [{ name: 'Fixture', records: 42, frequency: 'Diaria', lastUpdate: '2026-01-01' },
      { name: 'Unknown', records: 1, lastUpdate: null }] });
  assert.match(text, /2026-02-02/);
  assert.match(text, /2026-01-01/);
  assert.match(text, /desconocida/);
  assert.ok(!text.includes('999') && !text.includes('2099'));
});

test('HTTP OAuth 404, body bounds/chunking/malformed JSON/abort and recovery', async t => {
  const server = createHttpServer({ apiBaseUrl: 'http://127.0.0.1:1' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  });
  for (const path of ['/authorize', '/token', '/register', '/mcp/callback', '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/openid-configuration']) {
    for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await fetch(base + path, { method })).status, 404, `${method} ${path}`);
    }
  }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers, body: 'x'.repeat(65537) })).status, 413);
  function chunked(chunks: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(base + '/mcp', { method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject);
      for (const chunk of chunks) req.write(chunk);
      req.end();
    });
  }
  const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal(await chunked([message + ' '.repeat(65536 - Buffer.byteLength(message))]), 200);
  assert.equal(await chunked([' '.repeat(32768), ' '.repeat(32769)]), 413);
  assert.equal(await chunked(['"', 'é'.repeat(32768), '"']), 413);
  // Truncated body: half-close socket. Node returns 400 and the process remains healthy.
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('abort test timeout')));
    socket.on('error', reject);
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('close', () => resolve(response));
    socket.on('connect', () => socket.end('POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'));
  });
  assert.match(raw, /400/);
  assert.equal((await fetch(base + '/health')).status, 200);
});
