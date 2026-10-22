import * as metrics from './metrics.js';
import type { ToolRegistry } from './tool-registry.js';

/** Adds the existing aggregate-only metrics wrapper to either SDK registry. */
export function instrumentToolRegistry(server: ToolRegistry, authMode: metrics.AuthMode): void {
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name: string, options: unknown, handler: (...args: any[]) => Promise<unknown>) => {
    const toolName = metrics.normTool(name);
    return registerTool(name, options, async (...args: any[]) => {
      const start = performance.now();
      try {
        const result = await handler(...args);
        const response = result as Record<string, unknown>;
        const totalMs = performance.now() - start;
        const upstreamMs = typeof response.upstreamMs === 'number' ? response.upstreamMs : 0;
        const upstreamStatus = typeof response.upstreamStatus === 'number' ? response.upstreamStatus : 0;
        const statusGroup = response.isError === true
          ? (upstreamStatus >= 400 && upstreamStatus < 500 ? '4xx' : '5xx')
          : '2xx';
        metrics.record(toolName, authMode, statusGroup, totalMs, upstreamMs);
        delete response.upstreamMs;
        delete response.upstreamStatus;
        return response;
      } catch (error) {
        metrics.record(toolName, authMode, '5xx', performance.now() - start, 0);
        throw error;
      }
    });
  };
}
