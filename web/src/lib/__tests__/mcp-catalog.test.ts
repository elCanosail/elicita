import { describe, expect, it } from 'vitest';
import { MCP_ENDPOINT, MCP_PROTOCOL_VERSION, MCP_TOOLS } from '../mcp-catalog';

describe('MCP public catalog', () => {
  it('exposes only the four stable server tools', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
      'search_licitaciones',
      'get_stats',
      'get_cobertura',
      'search_cpv',
    ]);
  });

  it('matches the deployed protocol contract', () => {
    expect(MCP_ENDPOINT).toBe('https://elicita.es/mcp');
    expect(MCP_PROTOCOL_VERSION).toBe('2025-06-18');
  });
});
