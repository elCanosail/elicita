/**
 * Small common surface implemented by the v1 and v2 MCP server SDKs.
 * Tool modules depend on this boundary rather than either SDK so one
 * registration definition supplies both transports. The SDKs intentionally
 * expose different overloaded handler types, so the boundary keeps that
 * adapter detail outside the semantic tool implementations.
 */
export interface ToolRegistry {
  registerTool: (...args: any[]) => unknown;
}
