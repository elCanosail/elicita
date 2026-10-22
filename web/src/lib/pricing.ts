/**
 * Single source of truth for Elicita public pricing.
 * Used by homepage and /precios.
 *
 * Two plans: Free and Pro (€29/mo).
 * Pro includes paid search, API keys and authenticated MCP access.
 * Team needs are handled by contact while enterprise capabilities mature.
 */

export interface PricingFeature {
  text: string;
  included: boolean;
}

export interface PricingPlan {
  id: 'free' | 'pro';
  name: string;
  description: string;
  priceMonthly: number;
  priceAnnual: number;
  badge: string | null;
  features: PricingFeature[];
  ctas: {
    home: { label: string; href: string; primary: boolean };
    page: { label: string; href: string; primary: boolean };
  };
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    description: 'Explora el mundo de la contratación pública.',
    priceMonthly: 0,
    priceAnnual: 0,
    badge: null,
    features: [
      { text: 'Perfil automático por CIF', included: true },
      { text: '3 búsquedas/día', included: true },
      { text: 'Monitor de licitaciones activas', included: true },
      { text: 'Fichas de mercado de 7 sectores', included: true },
      { text: 'Alertas por email', included: false },
      { text: 'Universo — grafo de relaciones', included: false },
      { text: 'BORME — registro mercantil', included: false },
      { text: 'Cargos compartidos', included: false },
      { text: 'Alertas de competidores', included: false },
      { text: 'MCP público: estadísticas, cobertura y CPV', included: true },
      { text: 'Búsqueda MCP y API con clave personal', included: false },
    ],
    ctas: {
      home: { label: 'Probar búsqueda gratis →', href: '/buscar', primary: false },
      page: { label: 'Empezar gratis', href: '/sign-up', primary: false },
    },
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'Para profesionales que necesitan buscar, vigilar y trabajar desde su asistente de IA.',
    priceMonthly: 29,
    priceAnnual: 290,
    badge: 'Recomendado',
    features: [
      { text: 'Búsquedas ilimitadas — histórico 2022+ (13,4M+ registros PLACSP)', included: true },
      { text: 'Filtros avanzados: CPV, importe, fuente, NIF, fechas', included: true },
      { text: 'Grafo Universo con presets de 7 sectores', included: true },
      { text: 'Market Intelligence — snapshots deterministas con checksums', included: true },
      { text: 'Perfil de competidores', included: true },
      { text: 'Export CSV de búsquedas', included: true },
      { text: 'Universo ilimitado + expansión nivel 3', included: true },
      { text: 'BORME — registro mercantil integrado', included: true },
      { text: 'Cargos compartidos detectados', included: true },
      { text: 'Alertas de competidores y compradores', included: true },
      { text: 'BOE integrado', included: true },
      { text: 'API access — CRM/ERP propio', included: true },
      { text: 'MCP autenticado — búsqueda desde tu asistente de IA', included: true },
    ],
    ctas: {
      home: { label: 'Suscribir →', href: '/sign-up', primary: true },
      page: { label: 'Suscribir', href: '/sign-up', primary: true },
    },
  },
];

export function formatPrice(amount: number): string {
  return amount.toLocaleString('es-ES');
}