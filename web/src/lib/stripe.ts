/**
 * Stripe configuration for Elicita
 * 2 public plans: Free, Pro (€29/mo) — Pro includes API+MCP.
 * Empresa and Developer kept for backward compat (existing subscribers).
 * All prices tax_behavior=inclusive
 */
import Stripe from 'stripe';

export const stripe = new Stripe(
  import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '',
  { apiVersion: '2024-12-18.acacia' }
);

export type PlanId = 'pro' | 'empresa' | 'developer';

export interface PlanConfig {
  id: PlanId;
  name: string;
  productId: string;
  prices: {
    monthly: string;
    annual: string;
  };
  monthlyAmount: number;
  annualAmount: number;
  features: string[];
}

export const PLANS: Record<PlanId, PlanConfig> = {
  pro: {
    id: 'pro',
    name: 'Pro',
    productId: 'prod_U7RPKGSJMHmCS9',
    prices: {
      monthly: import.meta.env.STRIPE_PRO_MONTHLY_PRICE_ID || process.env.STRIPE_PRO_MONTHLY_PRICE_ID || '',
      annual: import.meta.env.STRIPE_PRO_ANNUAL_PRICE_ID || process.env.STRIPE_PRO_ANNUAL_PRICE_ID || '',
    },
    monthlyAmount: 2900,
    annualAmount: 29000,
    features: [
      'Monitor completo (licitaciones en tiempo real)',
      'Explorer — proyecciones y renovaciones',
      'Buscador ilimitado (63M+ registros)',
      'Perfil de competidores',
      'Alertas diarias por email',
      'Export PDF',
    ],
  },
  developer: {
    id: 'developer',
    name: 'Developer',
    productId: '',
    prices: {
      monthly: import.meta.env.STRIPE_DEVELOPER_MONTHLY_PRICE_ID || process.env.STRIPE_DEVELOPER_MONTHLY_PRICE_ID || '',
      annual: import.meta.env.STRIPE_DEVELOPER_ANNUAL_PRICE_ID || process.env.STRIPE_DEVELOPER_ANNUAL_PRICE_ID || '',
    },
    monthlyAmount: 4900,
    annualAmount: 49000,
    features: [
      'Buscador ilimitado (63M+ registros)',
      'MCP access — 1 asistente AI',
      'API rate limit: 100 queries/día',
      'Sin alertas',
      '1 usuario',
    ],
  },
  empresa: {
    id: 'empresa',
    name: 'Empresa',
    productId: 'prod_U7RPXFVSF4p584',
    prices: {
      monthly: 'price_1T9CX9RlVvV3kbDFPxTaQKhQ',
      annual: 'price_1T9CX9RlVvV3kbDFYDg78ptu',
    },
    monthlyAmount: 59900,
    annualAmount: 599000,
    features: [
      'Todo lo de Pro',
      'API access — integración con tu CRM/ERP',
      'MCP access — asistente AI conectado a tus datos',
      'Hasta 5 usuarios',
      'Soporte prioritario',
      'Integraciones custom',
    ],
  },
};

export const IVA_TAX_RATE_ID = 'txr_1TsSKhRlVvV3kbDFAoHplPyQ';

/** Get plan from Stripe price ID */
export function getPlanFromPriceId(priceId: string): PlanConfig | null {
  for (const plan of Object.values(PLANS)) {
    if (plan.prices.monthly === priceId || plan.prices.annual === priceId) {
      return plan;
    }
  }
  return null;
}

/** Get plan from Stripe product ID */
export function getPlanFromProductId(productId: string): PlanConfig | null {
  return Object.values(PLANS).find(p => p.productId === productId) || null;
}
