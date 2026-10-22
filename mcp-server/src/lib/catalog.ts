import type { ApprovedSnapshotConfigs } from './approved-snapshot.js';
import type { ElicitaApiConfig } from './types.js';
import type { ToolRegistry } from './tool-registry.js';
import type { AuthMode } from './metrics.js';
import { registerCoberturaTool } from '../tools/cobertura.js';
import { registerCpvTool } from '../tools/cpv.js';
import { registerSearchTool } from '../tools/search.js';
import { registerStatsTool } from '../tools/stats.js';
import {
  MARKET_INTELLIGENCE_TOOL_NAMES,
  registerMarketIntelligenceTools,
} from '../tools/market-intelligence.js';

export const API_KEY_TOOL_NAMES = ['search_licitaciones'] as const;
export const LEGACY_PUBLIC_TOOL_NAMES = [
  'get_stats',
  'get_cobertura',
  'search_cpv',
] as const;
export { MARKET_INTELLIGENCE_TOOL_NAMES };

export const STABLE_TOOL_NAMES = [
  ...API_KEY_TOOL_NAMES,
  ...LEGACY_PUBLIC_TOOL_NAMES,
  ...MARKET_INTELLIGENCE_TOOL_NAMES,
] as const;

/**
 * Registers the only production catalog. Both SDK handlers call this function,
 * preventing a protocol-era-specific copy of contracts or tool semantics.
 */
export function registerStableToolset(
  server: ToolRegistry,
  config: ElicitaApiConfig,
  authMode: AuthMode,
  approvedSnapshotConfigs?: ApprovedSnapshotConfigs,
): void {
  if (authMode === 'api_key') registerSearchTool(server, config);
  registerStatsTool(server, config);
  registerCoberturaTool(server, config);
  registerCpvTool(server, config);
  if (approvedSnapshotConfigs && Object.keys(approvedSnapshotConfigs).length > 0) {
    registerMarketIntelligenceTools(server, approvedSnapshotConfigs);
  }
}
