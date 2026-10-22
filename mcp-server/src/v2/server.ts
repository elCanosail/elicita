import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

import { BodyError, readMcpBody } from '../lib/body.js';
import {
  createV2SidecarHandler,
  INTERNAL_CLIENT_IP_HEADER,
  MCP_V2_SERVER_VERSION,
  MCP_V2_TRANSPORT,
  type V2SidecarConfig,
} from './sidecar.js';

export const DEFAULT_MCP_V2_PATH = '/mcp-v2';

export interface V2HttpServerOptions extends V2SidecarConfig {
  path?: string;
}

export function createV2HttpServer(options: V2HttpServerOptions): ReturnType<typeof createServer> {
  const path = validatePath(options.path ?? DEFAULT_MCP_V2_PATH);
  const sidecar = createV2SidecarHandler(options);
  const server = createServer(async (req, res) => {
    let url: URL;
    try { url = new URL(req.url || '/', 'http://sidecar.invalid'); }
    catch { sendJson(res, 400, { error: 'invalid_request_url' }); return; }

    if (url.pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        version: MCP_V2_SERVER_VERSION,
        transport: MCP_V2_TRANSPORT,
      });
      return;
    }
    if (url.pathname !== path) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const request = toWebRequest(req);
    const rejected = sidecar.validate(request);
    if (rejected) {
      writeFetchResponse(res, rejected);
      return;
    }

    try {
      const parsedBody = req.method === 'POST' ? await readMcpBody(req) : undefined;
      const response = await sidecar.dispatch(request, { parsedBody });
      writeFetchResponse(res, response);
    } catch (error) {
      if (error instanceof BodyError) {
        if (!res.destroyed && !res.headersSent) {
          sendJson(res, error.status, { error: error.message }, { Connection: 'close' });
        }
        return;
      }
      // Never include request data or error messages: either can carry query,
      // credentials or user identifiers from an upstream/client error.
      console.error('mcp_v2_request_failed');
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_server_error' });
    }
  });

  server.on('close', () => { sidecar.close().catch(() => {}); });
  return server;
}

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (name === INTERNAL_CLIENT_IP_HEADER || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set(INTERNAL_CLIENT_IP_HEADER, getClientIp(req));
  return new Request(`http://sidecar.invalid${req.url || '/'}`, {
    method: req.method || 'GET',
    headers,
  });
}

function getClientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>): string {
  const peer = req.socket.remoteAddress || 'unknown';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const realIp = req.headers['x-real-ip'];
  return loopback && typeof realIp === 'string' && isIP(realIp) ? realIp : peer;
}

function validatePath(path: string): string {
  if (!/^\/[A-Za-z0-9._/-]*$/.test(path) || path === '/') {
    throw new Error('MCP_V2_PATH must be a non-root absolute path without a query');
  }
  return path;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function writeFetchResponse(res: ServerResponse, response: Response): void {
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  body.on('error', () => res.destroy());
  body.pipe(res);
}
