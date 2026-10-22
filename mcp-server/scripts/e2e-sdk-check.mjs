#!/usr/bin/env node
/**
 * E2E check: official @modelcontextprotocol/sdk client against the local MCP server.
 *
 * Verifies (all against ephemeral local servers, never production):
 *   - initialize + tools/list do not consume backend search quota
 *   - anonymous search routes to /api/public/search, one call per search
 *   - well-formed mock key routes to /api/v1/search with credential present
 *   - malformed Bearer is rejected with HTTP 401 (no anonymous fallback)
 *   - well-formed but revoked key -> 401 surfaced as isError (no fallback)
 *   - quota exhausted -> 429 surfaced as isError (no retry)
 *   - no credential is ever echoed in tool output
 *
 * Run:  tsx scripts/e2e-sdk-check.mjs   (or via `npm run e2e:sdk`)
 * Exit code 0 = all checks passed; non-zero = a check failed.
 */

import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { createHttpServer } = await import('../src/server.js');

const VALID_KEY = `elicita_live_${'a'.repeat(32)}_${'b'.repeat(48)}`;
const REVOKED_KEY = `elicita_live_${'c'.repeat(32)}_${'d'.repeat(48)}`;
const STABLE_TOOLS = ['search_licitaciones', 'get_stats', 'get_cobertura', 'search_cpv'];

const results = [];
function pass(name) { results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
function fail(name, detail) { results.push({ name, ok: false, detail }); console.error(`  FAIL  ${name}: ${detail}`); }
async function check(name, fn) {
  try { await fn(); pass(name); } catch (err) { fail(name, err && err.message ? err.message : String(err)); }
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${server.address().port}`);
  }));
}
function close(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(e => (e ? reject(e) : resolve()));
  });
}

async function main() {
  const calls = [];
  const backend = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), credentialPresent: !!req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/api/v1/search') {
      if (req.headers.authorization === `Bearer ${REVOKED_KEY}`) { res.writeHead(401); res.end(JSON.stringify({ error: 'api_key_revoked' })); return; }
      if (url.searchParams.get('q') === 'quota') { res.writeHead(429); res.end(JSON.stringify({ error: 'Quota exceeded' })); return; }
      res.end(JSON.stringify({ results: [{ id: 'auth-fixture', titulo: 'Contrato autenticado', importe_licitacion: 20 }], pagination: { limit: 1, offset: 0, has_more: false }, meta: { total: 1 } }));
      return;
    }
    if (url.pathname === '/api/public/search') {
      if (url.searchParams.get('q') === 'quota') { res.writeHead(429); res.end(JSON.stringify({ error: 'Quota exceeded' })); return; }
      res.end(JSON.stringify({ results: [{ id: 'anon-fixture', titulo: 'Contrato público', importe_licitacion: 10 }], pagination: { limit: 1, offset: 0, has_more: false }, meta: { total: 1 } }));
      return;
    }
    res.writeHead(404); res.end(JSON.stringify({ error: 'not_found' }));
  });

  const apiBaseUrl = await listen(backend);
  const server = createHttpServer({ apiBaseUrl });
  const base = await listen(server);

  const clients = [];
  const connect = async (bearer) => {
    const client = new Client({ name: 'e2e-sdk-check', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } },
    }));
    return client;
  };

  try {
    console.log('Elicita MCP SDK e2e check (local mock, ephemeral ports)');

    // 1. initialize + listTools must not consume backend search quota.
    const anonymous = await connect();
    await check('initialize exposes server identity', async () => {
      const info = anonymous.getServerVersion();
      if (info?.name !== 'elicita-mcp-server') throw new Error(`unexpected server name ${info?.name}`);
      if (info?.version !== '1.0.0') throw new Error(`unexpected version ${info?.version}`);
    });
    await check('tools/list returns the four stable tools (no quota consumed)', async () => {
      const names = (await anonymous.listTools()).tools.map(x => x.name);
      if (JSON.stringify(names) !== JSON.stringify(STABLE_TOOLS)) throw new Error(`tools ${JSON.stringify(names)}`);
      if (calls.length !== 0) throw new Error(`initialize/listTools reached backend ${calls.length} times`);
    });
    for (let i = 0; i < 3; i++) await anonymous.listTools();
    await check('repeated listTools stays zero backend calls', async () => {
      if (calls.length !== 0) throw new Error(`listTools reached backend ${calls.length} times`);
    });

    // 2. Three anonymous searches -> three calls to /api/public/search.
    for (let i = 0; i < 3; i++) {
      const r = await anonymous.callTool({ name: 'search_licitaciones', arguments: { q: 'fixture', limit: 1 } });
      if (r.isError) throw new Error(`anonymous search ${i + 1} errored: ${JSON.stringify(r.content)}`);
    }
    await check('3 anonymous searches -> 3 backend calls (no 3 handshakes)', async () => {
      if (calls.length !== 3) throw new Error(`expected 3 calls, got ${calls.length}`);
      if (!calls.every(c => c.path === '/api/public/search' && !c.credentialPresent)) throw new Error('anon calls did not hit /api/public/search without credential');
    });

    // 3. Valid mock key routes to authenticated path.
    const authenticated = await connect(VALID_KEY);
    await authenticated.listTools();
    const authResult = await authenticated.callTool({ name: 'search_licitaciones', arguments: { q: 'fixture', limit: 1 } });
    await check('valid mock key uses /api/v1/search with credential', async () => {
      if (authResult.isError) throw new Error(`auth search errored: ${JSON.stringify(authResult.content)}`);
      const last = calls.at(-1);
      if (last.path !== '/api/v1/search' || !last.credentialPresent) throw new Error(`unexpected call ${JSON.stringify(last)}`);
    });

    // 4. Malformed Bearer -> HTTP 401 at connect; no backend call.
    const beforeInvalid = calls.length;
    let invalidRejected = false;
    try { await connect('not-a-valid-key'); } catch (err) { invalidRejected = (err && err.code) === 401; }
    await check('malformed Bearer rejected with HTTP 401 (no anonymous fallback)', async () => {
      if (!invalidRejected) throw new Error('connect did not reject with 401');
      if (calls.length !== beforeInvalid) throw new Error('backend called for an invalid credential');
    });

    // 5. Well-formed but revoked key -> 401 isError; no fallback.
    const beforeRevoked = calls.length;
    const revoked = await connect(REVOKED_KEY);
    const revokedResult = await revoked.callTool({ name: 'search_licitaciones', arguments: { q: 'fixture' } });
    await check('revoked key surfaced as isError with no anonymous fallback', async () => {
      if (!revokedResult.isError) throw new Error('expected isError');
      if (!/401/.test(JSON.stringify(revokedResult.content))) throw new Error('missing 401 in output');
      if (calls.length !== beforeRevoked + 1) throw new Error(`expected +1 call, got ${calls.length - beforeRevoked}`);
      const last = calls.at(-1);
      if (last.path !== '/api/v1/search' || !last.credentialPresent) throw new Error(`unexpected call ${JSON.stringify(last)}`);
      if (calls.slice(beforeRevoked).some(c => c.path === '/api/public/search')) throw new Error('anonymous fallback occurred after revoked key');
    });

    // 6. Quota exhausted -> 429 isError; exactly one call, no retry.
    const beforeQuota = calls.length;
    const quota = await anonymous.callTool({ name: 'search_licitaciones', arguments: { q: 'quota' } });
    await check('quota exhausted -> 429 isError, single call, no retry', async () => {
      if (!quota.isError) throw new Error('expected isError');
      if (!/429/.test(JSON.stringify(quota.content))) throw new Error('missing 429 in output');
      if (calls.length !== beforeQuota + 1) throw new Error(`expected +1 call, got ${calls.length - beforeQuota}`);
      if (calls.at(-1).path !== '/api/public/search') throw new Error('quota call did not hit public path');
    });

    // 7. No credential echoed anywhere.
    const all = [JSON.stringify(authResult), JSON.stringify(revokedResult), JSON.stringify(quota)].join(' ');
    await check('no credential is echoed in tool output', async () => {
      if (all.includes(VALID_KEY) || all.includes(REVOKED_KEY)) throw new Error('credential leaked in output');
    });
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await close(server);
    await close(backend);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.error('FAILED checks:');
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('e2e-sdk-check crashed:', err);
  process.exit(1);
});
