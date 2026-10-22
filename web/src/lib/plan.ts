/**
 * Plan detection for Elicita
 * Priority: Admin → Stripe subscription (via Clerk metadata) → Free
 *
 * Two plans: Free (limited) and Pro (€29/mo, paid search and authenticated access).
 */
import { PLANS, type PlanId, type PlanConfig } from './stripe';

export type EffectivePlan = PlanId | 'free';

export interface UserPlan {
  plan: EffectivePlan;
  planName: string;
  status: string;
  interval: 'month' | 'year' | null;
  periodEnd: number | null;
  config: PlanConfig | null;
  hasAccess: boolean;
  apiEnabled?: boolean;
  mcpEnabled?: boolean;
  queriesLimit?: number;
  maxAlerts: number;
}

export const ADMIN_USERNAMES = ['admin'];
// Los identificadores reales de administradores se eliminaron en la edición pública.
export const ADMIN_IDS: string[] = [];

export type Feature =
  | 'monitor_full'
  | 'explorer'
  | 'buscador_unlimited'
  | 'buscador_limited'
  | 'alerts'
  | 'export_pdf'
  | 'api_access'
  | 'mcp_access';

const FEATURE_MAP: Record<EffectivePlan, Feature[]> = {
  free: ['monitor_full', 'explorer', 'buscador_limited', 'export_pdf'],
  pro: ['monitor_full', 'explorer', 'buscador_unlimited', 'alerts', 'export_pdf', 'api_access', 'mcp_access'],
  developer: ['buscador_unlimited', 'mcp_access', 'api_access'],
  empresa: ['monitor_full', 'explorer', 'buscador_unlimited', 'alerts', 'export_pdf', 'api_access', 'mcp_access'],
};

export function canAccessFeature(plan: EffectivePlan, feature: Feature): boolean {
  return FEATURE_MAP[plan]?.includes(feature) ?? false;
}

export function getMaxAlerts(plan: EffectivePlan): number {
  switch (plan) {
    case 'free':
      return 1;
    case 'developer':
      return 0;
    case 'pro':
    case 'empresa':
      return Infinity;
    default:
      return 1;
  }
}

/**
 * Resolve user plan from Clerk publicMetadata
 */
export function getUserPlan(
  metadata: Record<string, any>,
  username?: string,
  userId?: string,
): UserPlan {
  // 1. Admin override
  if (
    (username && ADMIN_USERNAMES.includes(username)) ||
    (userId && ADMIN_IDS.includes(userId))
  ) {
    return {
      plan: 'empresa',
      planName: 'Empresa (Admin)',
      status: 'active',
      interval: 'year',
      periodEnd: null,
      config: PLANS.empresa,
      hasAccess: true,
      apiEnabled: true,
      mcpEnabled: true,
      queriesLimit: 10000,
      maxAlerts: Infinity,
    };
  }

  // 2. Stripe subscription from Clerk metadata
  const rawPlan = metadata?.plan as string | undefined;
  const status = metadata?.plan_status as string | undefined;
  const interval = metadata?.plan_interval as 'month' | 'year' | undefined;
  const periodEnd = metadata?.plan_current_period_end as number | undefined;

  const apiEnabled = metadata?.api_enabled as boolean | undefined;
  const mcpEnabled = metadata?.mcp_enabled as boolean | undefined;
  const queriesLimit = metadata?.queries_limit as number | undefined;
  let planId: EffectivePlan = 'free';
  if (rawPlan === 'pro' || rawPlan === 'inteligencia') planId = 'pro';
  else if (rawPlan === 'empresa') planId = 'empresa';
  else if (rawPlan === 'developer') planId = 'developer';
  // Old plans (monitor, operador, starter) → treat as pro
  else if (rawPlan === 'starter') planId = 'pro';
  else if (rawPlan === 'monitor' || rawPlan === 'operador') planId = 'pro';

  if (planId !== 'free' && status === 'active') {
    const config = PLANS[planId] || null;
    return {
      plan: planId,
      planName: config?.name || planId,
      status: 'active',
      interval: interval || null,
      periodEnd: periodEnd || null,
      config,
      hasAccess: true,
      apiEnabled: apiEnabled ?? true,
      mcpEnabled: mcpEnabled ?? true,
      queriesLimit:
        queriesLimit ??
        (planId === 'empresa' ? 10000 : planId === 'developer' ? 100 : 1000),
      maxAlerts: getMaxAlerts(planId),
    };
  }

  // 3. Default: free (limited access, no time limit)
  return {
    plan: 'free',
    planName: 'Free',
    status: status || 'none',
    interval: null,
    periodEnd: null,
    config: null,
    hasAccess: true,
    apiEnabled: false,
    mcpEnabled: false,
    queriesLimit: 3, // 3 searches per day for free tier
    maxAlerts: 0,
  };
}