#!/usr/bin/env node
import { approvedSnapshotConfigsFromEnvironment } from '../lib/approved-snapshot.js';
import { createV2HttpServer, DEFAULT_MCP_V2_PATH } from './server.js';
import { v2SidecarConfigFromEnvironment } from './sidecar.js';

export function startV2Sidecar(): ReturnType<typeof createV2HttpServer> {
  const port = Number.parseInt(process.env.MCP_V2_PORT || '4327', 10);
  const host = process.env.MCP_V2_HOST || '127.0.0.1';
  const path = process.env.MCP_V2_PATH || DEFAULT_MCP_V2_PATH;
  const allowlists = v2SidecarConfigFromEnvironment();
  const server = createV2HttpServer({
    apiBaseUrl: (process.env.ELICITA_API_URL || 'http://localhost:4321').replace(/\/$/, ''),
    approvedSnapshotConfigs: approvedSnapshotConfigsFromEnvironment(),
    path,
    ...allowlists,
  });

  server.listen(port, host, () => {
    console.log(`Elicita MCP v2 sidecar escuchando en http://${host}:${port}${path}`);
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

startV2Sidecar();
