import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { resolveRequestCredential } from './lib/auth.js';
import { readMcpBody, BodyError } from './lib/body.js';
import { isIP } from 'node:net';
import type { ElicitaApiConfig } from './lib/types.js';
import { registerStableToolset, STABLE_TOOL_NAMES, LEGACY_PUBLIC_TOOL_NAMES } from './lib/catalog.js';
import { approvedSnapshotConfigsFromEnvironment } from './lib/approved-snapshot.js';
import { instrumentToolRegistry } from './lib/instrumentation.js';
import type { ToolRegistry } from './lib/tool-registry.js';
import * as metrics from './lib/metrics.js';

export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_TRANSPORT = 'streamable-http';

export { STABLE_TOOL_NAMES };

export const PUBLIC_TOOL_NAMES = [
  ...LEGACY_PUBLIC_TOOL_NAMES,
  'market_snapshot',
  'rank_companies',
  'analyze_buyer',
  'trace_metric',
] as const;

export const EXPERIMENTAL_TOOL_NAMES = [
  'get_organismo',
  'graph_search',
  'graph_contracts',
  'analyze_pliego',
  'radar_opportunities',
] as const;

// Reduced v1 release: no credential or environment flag can enable experimental tools.
export async function registerToolset(
  server: ToolRegistry,
  config: ElicitaApiConfig,
  authMode: metrics.AuthMode
): Promise<void> {
  registerStableToolset(server, config, authMode, approvedSnapshotConfigsFromEnvironment());
}

export async function createMcpServer(
  config: ElicitaApiConfig,
  authMode: metrics.AuthMode = 'anonymous'
): Promise<McpServer> {
  const server = new McpServer(
    {
      name: 'elicita-mcp-server',
      version: MCP_SERVER_VERSION,
    },
    {
      instructions:
        'Interfaz MCP de Elicita para buscar contratación pública española en fuentes oficiales.',
      capabilities: { tools: {} },
    }
  );

  instrumentToolRegistry(server, authMode);
  await registerToolset(server, config, authMode);
  return server;
}

export interface HttpServerOptions {
  apiBaseUrl?: string;
}

export function getClientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>): string {
  const peer = req.socket.remoteAddress || 'unknown';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const realIp = req.headers['x-real-ip'];
  // Only the loopback proxy may supply X-Real-IP; never trust CF/XFF from clients.
  return loopback && typeof realIp === 'string' && isIP(realIp) ? realIp : peer;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function createHttpServer(options: HttpServerOptions = {}): ReturnType<typeof createServer> {
  const apiBaseUrl = (options.apiBaseUrl || process.env.ELICITA_API_URL || 'http://localhost:4321').replace(/\/$/, '');

  return createServer(async (req, res) => {
    let url: URL;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { sendJson(res, 400, { error: 'invalid_request_url' }); return; }

    if (url.pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        version: MCP_SERVER_VERSION,
        transport: MCP_TRANSPORT,
      });
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const requestId = metrics.generateRequestId();
    res.setHeader('X-Request-ID', requestId);

    const credential = resolveRequestCredential(req.headers);
    if (credential.status === 'invalid') {
      sendJson(
        res,
        401,
        { error: 'unauthorized' },
        { 'WWW-Authenticate': 'Bearer realm="elicita-mcp"' }
      );
      return;
    }

    const authMode: metrics.AuthMode = credential.status === 'credential_present'
      ? 'api_key'
      : 'anonymous';

    const config: ElicitaApiConfig = {
      baseUrl: apiBaseUrl,
      apiKey: credential.apiKey,
      clientIp: getClientIp(req),
    };

    try {
      const parsedBody = req.method === 'POST' ? await readMcpBody(req) : undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: false,
      });
      const mcpServer = await createMcpServer(config, authMode);

      await mcpServer.connect(transport);
      res.on('close', () => {
        mcpServer.close().catch(() => {});
      });
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (error instanceof BodyError) {
        if (!res.destroyed && !res.headersSent) sendJson(res, error.status, { error: error.message }, { Connection: 'close' });
        return;
      }
      console.error('Error handling MCP request');
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_server_error' });
    }
  });
}
