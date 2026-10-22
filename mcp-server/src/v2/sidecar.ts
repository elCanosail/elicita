import {
  McpServer,
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type McpHandlerRequestOptions,
} from '@modelcontextprotocol/server';

import { resolveAuthorizationCredential } from '../lib/auth.js';
import type { ApprovedSnapshotConfigs } from '../lib/approved-snapshot.js';
import { registerStableToolset } from '../lib/catalog.js';
import { instrumentToolRegistry } from '../lib/instrumentation.js';
import type { ElicitaApiConfig } from '../lib/types.js';

export const MCP_V2_SERVER_VERSION = '2.0.0';
export const MCP_V2_TRANSPORT = 'streamable-http';
export const INTERNAL_CLIENT_IP_HEADER = 'x-elicita-internal-client-ip';

export interface V2SidecarConfig {
  apiBaseUrl: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  approvedSnapshotConfigs?: ApprovedSnapshotConfigs;
}

export interface V2SidecarHandler {
  validate(request: Request): Response | undefined;
  dispatch(request: Request, options?: McpHandlerRequestOptions): Promise<Response>;
  fetch(request: Request, options?: McpHandlerRequestOptions): Promise<Response>;
  close(): Promise<void>;
}

/**
 * SDK v2 entry with one factory for legacy stateless and 2026-07-28 traffic.
 * The host layer calls validate before consuming a POST body; fetch remains
 * available for Fetch-native deployments and repeats that gate itself.
 */
export function createV2SidecarHandler(config: V2SidecarConfig): V2SidecarHandler {
  const allowedHosts = validateAllowlist(config.allowedHosts, 'allowedHosts');
  const allowedOrigins = validateAllowlist(config.allowedOrigins, 'allowedOrigins');
  const handler = createMcpHandler(
    context => {
      const credential = resolveAuthorizationCredential(
        context.authInfo?.clientId === 'direct-api-key'
          ? `Bearer ${context.authInfo.token}`
          : context.requestInfo?.headers.get('authorization'),
      );
      const authMode = credential.status === 'credential_present' ? 'api_key' : 'anonymous';
      const apiConfig: ElicitaApiConfig = {
        baseUrl: config.apiBaseUrl,
        apiKey: credential.status === 'credential_present' ? credential.apiKey : '',
        clientIp: context.requestInfo?.headers.get(INTERNAL_CLIENT_IP_HEADER) ?? undefined,
      };
      const server = new McpServer(
        { name: 'elicita-mcp-sidecar', version: MCP_V2_SERVER_VERSION },
        {
          instructions: 'Interfaz MCP de Elicita para buscar contratación pública española en fuentes oficiales.',
          capabilities: { tools: {} },
        },
      );
      instrumentToolRegistry(server, authMode);
      registerStableToolset(server, apiConfig, authMode, config.approvedSnapshotConfigs);
      return server;
    },
    {
      legacy: 'stateless',
      onerror: () => { console.error('mcp_v2_protocol_error'); },
    },
  );

  const validate = (request: Request): Response | undefined => {
    const rejected = hostHeaderValidationResponse(request, allowedHosts)
      ?? originValidationResponse(request, allowedOrigins);
    if (rejected) return rejected;

    const credential = resolveAuthorizationCredential(request.headers.get('authorization'));
    if (credential.status === 'invalid') {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'WWW-Authenticate': 'Bearer realm="elicita-mcp"',
        },
      });
    }
    return undefined;
  };

  const dispatch = (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
    const credential = resolveAuthorizationCredential(request.headers.get('authorization'));
    const authInfo = credential.status === 'credential_present'
      ? { token: credential.apiKey, clientId: 'direct-api-key', scopes: [] }
      : undefined;
    return handler.fetch(request, { ...options, authInfo });
  };

  return {
    validate,
    dispatch,
    async fetch(request, options) {
      return validate(request) ?? dispatch(request, options);
    },
    close: () => handler.close(),
  };
}

export function v2SidecarConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Pick<V2SidecarConfig, 'allowedHosts' | 'allowedOrigins'> {
  return {
    allowedHosts: parseAllowlist(environment.ELICITA_MCP_V2_ALLOWED_HOSTS, 'ELICITA_MCP_V2_ALLOWED_HOSTS'),
    allowedOrigins: parseAllowlist(environment.ELICITA_MCP_V2_ALLOWED_ORIGINS, 'ELICITA_MCP_V2_ALLOWED_ORIGINS'),
  };
}

function parseAllowlist(value: string | undefined, name: string): string[] {
  if (!value) throw new Error(`${name} is required for the MCP v2 sidecar`);
  return validateAllowlist(value.split(',').map(item => item.trim()).filter(Boolean), name);
}

function validateAllowlist(values: readonly string[], name: string): string[] {
  if (values.length === 0) throw new Error(`${name} must not be empty`);
  const hostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const normalized = values.map(value => value.toLowerCase());
  if (normalized.some(value => !hostname.test(value) || value === '*' || value.includes('localhost'))) {
    throw new Error(`${name} must contain explicit non-localhost hostnames only`);
  }
  return [...new Set(normalized)];
}
