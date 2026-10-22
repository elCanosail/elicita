import { useState, useEffect, useMemo } from "react";

/**
 * KpiStrip — KPI cards con datos reales del mercado de contratación pública.
 * Reemplaza MetricsDashboard (que tenía datos demo).
 *
 * Datos desde /api/stats:
 * - totalHistorical: 30.8M registros
 * - byYear: evolución 2015-2025
 * - byTipo: distribución por tipo
 * - pipeline: fuentes en tiempo real
 *
 * Cada card: label + valor (tabular-nums) + delta con icono ↑↓ + sparkline opcional
 * Color semántico en delta, no en valor principal.
 */

interface KpiCardProps {
  label: string;
  value: string;
  delta?: { value: number; label: string };
  sparklineData?: number[];
  icon?: string;
}

const TABULAR = { fontVariantNumeric: "tabular-nums" } as React.CSSProperties;

function Sparkline({ data, color = "hsl(var(--primary))" }: { data: number[]; color?: string }) {
  if (!data || data.length < 2) return null;
  const w = 60;
  const h = 20;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="opacity-60" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KpiCard({ label, value, delta, sparklineData, icon }: KpiCardProps) {
  const isPositive = (delta?.value ?? 0) > 0;
  const isNegative = (delta?.value ?? 0) < 0;
  const deltaColor = isPositive
    ? "hsl(var(--primary))"
    : isNegative
    ? "hsl(var(--destructive))"
    : "hsl(var(--foreground) / 0.4)";
  const arrow = isPositive ? "↑" : isNegative ? "↓" : "→";

  return (
    <div className="bg-[hsl(var(--foreground)/0.02)] border border-[hsl(var(--foreground)/0.06)] rounded-lg px-5 py-4 flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-[hsl(var(--foreground)/0.4)] uppercase tracking-[0.06em]">
          {icon} {label}
        </span>
        {delta && (
          <span
            className="text-[11px] font-semibold text-[hsl(var(--primary))] font-[JetBrains_Mono] tabular-nums"
            style={{ color: deltaColor, ...TABULAR }}
          >
            {arrow} {isPositive ? "+" : ""}
            {delta.value.toFixed(1)}%
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-2">
        <span
          className="text-2xl font-bold text-[hsl(var(--foreground)/0.9)] font-[JetBrains_Mono] tabular-nums"
          style={{ ...TABULAR, lineHeight: 1.1 }}
        >
          {value}
        </span>
        {sparklineData && sparklineData.length > 1 && (
          <Sparkline data={sparklineData} color={deltaColor} />
        )}
      </div>
      {delta && (
        <span className="text-[10px] text-[hsl(var(--foreground)/0.3)]">
          {delta.label}
        </span>
      )}
    </div>
  );
}

interface StatsData {
  byYear: { year: number; count: number; meur: number }[];
  byTipo: { tipo: string; count: number }[];
  totalHistorical: number;
  totalRT: number;
  pipeline: Record<string, number>;
  sources: { key: string; name: string; count: number }[];
}

export default function KpiStrip() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((data) => {
        setStats(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const cards = useMemo(() => {
    if (!stats) return [];

    const currentYear = stats.byYear[stats.byYear.length - 1];
    const prevYear = stats.byYear[stats.byYear.length - 2];

    const yoyCount = prevYear
      ? ((currentYear.count - prevYear.count) / prevYear.count) * 100
      : 0;
    const yoyMeur = prevYear
      ? ((currentYear.meur - prevYear.meur) / prevYear.meur) * 100
      : 0;

    const sparkCounts = stats.byYear.slice(-5).map((y) => y.count);
    const sparkMeurs = stats.byYear.slice(-5).map((y) => y.meur);

    const formatM = (n: number) => {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
      return n.toString();
    };

    const formatMEur = (meur: number) => {
      if (meur >= 1_000) return `€${(meur / 1_000).toFixed(1)}B`;
      return `€${meur}M`;
    };

    return [
      {
        label: "Registros históricos",
        value: formatM(stats.totalHistorical),
        icon: "📊",
        delta: {
          value: yoyCount,
          label: `${currentYear.year} vs ${prevYear?.year}`,
        },
        sparklineData: sparkCounts,
      },
      {
        label: "Adjudicaciones " + currentYear.year,
        value: formatM(currentYear.count),
        icon: "📋",
        delta: {
          value: yoyCount,
          label: `${formatM(currentYear.count - prevYear.count)} vs ${prevYear?.year}`,
        },
        sparklineData: sparkCounts,
      },
      {
        label: "Importe adjudicado",
        value: formatMEur(currentYear.meur),
        icon: "💰",
        delta: {
          value: yoyMeur,
          label: `${formatMEur(currentYear.meur - prevYear.meur)} vs ${prevYear?.year}`,
        },
        sparklineData: sparkMeurs,
      },
      {
        label: "Fuentes activas",
        value: String(Object.keys(stats.pipeline).length),
        icon: "🔗",
        delta: {
          value: 0,
          label: `${stats.totalRT.toLocaleString("es-ES")} registros en pipeline`,
        },
      },
    ];
  }, [stats]);

  if (loading) {
    return (
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 px-8 py-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="bg-[hsl(var(--foreground)/0.02)] border border-[hsl(var(--foreground)/0.06)] rounded-lg px-5 py-4 h-[88px] animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (!stats || cards.length === 0) return null;

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 px-8 py-4 border-b border-[hsl(var(--foreground)/0.04)]">
      {cards.map((card, i) => (
        <KpiCard key={i} {...card} />
      ))}
    </div>
  );
}
