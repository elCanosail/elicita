#!/usr/bin/env node
import { createHttpServer } from './server.js';

export function startServer(): ReturnType<typeof createHttpServer> {
  const port = Number.parseInt(process.env.PORT || '4326', 10);
  const host = process.env.HOST || '127.0.0.1';
  const server = createHttpServer();

  server.listen(port, host, () => {
    console.log(`Elicita MCP server escuchando en http://${host}:${port}`);
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

// Executable entrypoint: PM2 imports this module through its fork wrapper.
// Tests and library consumers import server.ts instead.
startServer();
