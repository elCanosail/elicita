import * as React from "react";
import { DataGrid, type Column } from "../DataGrid";

const MES = ['', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const columns: Column[] = [
  { key: 'organismo', label: 'Organismo', sortable: true, width: '28%' },
  { key: 'cpv', label: 'CPV', sortable: true, mono: true, width: '12%' },
  { key: 'proximo', label: 'Próxima est.', sortable: true, mono: true, width: '14%', sortKey: 'proximo_raw', render: (_: any, row: any) => row.proximo_fmt },
  { key: 'intervalo', label: 'Intervalo', sortable: true, mono: true, width: '12%', sortKey: 'intervalo_raw', render: (_: any, row: any) => row.intervalo_fmt },
  { key: 'tendencia', label: 'Tendencia', sortable: true, width: '12%' },
  { key: 'mes', label: 'Mes típico', sortable: true, width: '12%', sortKey: 'mes_raw', render: (_: any, row: any) => row.mes_fmt },
  { key: 'confianza', label: 'Confianza', sortable: true, align: 'center', width: '10%', sortKey: 'confianza_raw' }
];

function fmtProximo(raw?: string) {
  if (!raw) return '—';
  const s = raw.replace('[PROYECCIÓN] ', '').trim();
  const m = s.match(/^(\d{4})-Q(\d)$/);
  if (m) return `Q${m[2]} ${m[1]}`;
  const m2 = s.match(/^(\d{4})-(\d{2})$/);
  if (m2) {
    try { return new Date(`${m2[1]}-${m2[2]}-01`).toLocaleDateString('es-ES', { month: 'short', year: 'numeric' }); } catch {}
  }
  return s;
}

function parseProximo(raw?: string): number {
  if (!raw) return 0;
  const s = raw.replace('[PROYECCIÓN] ', '').trim();
  const m = s.match(/^(\d{4})-Q(\d)$/);
  if (m) return parseInt(m[1], 10) * 10 + parseInt(m[2], 10);
  const m2 = s.match(/^(\d{4})-(\d{2})$/);
  if (m2) return parseInt(m[1], 10) * 100 + parseInt(m2[2], 10);
  return 0;
}

function dots(conf?: string) {
  const c = (conf || '').toLowerCase();
  const on = c === 'alta' ? 3 : c === 'media' ? 2 : 1;
  return (
    <span className="td-conf">
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          style={{
            color: i < on
              ? (c === 'alta' ? 'hsl(var(--primary))' : c === 'media' ? 'hsl(var(--warning))' : 'hsl(var(--foreground) / 0.25)')
              : 'hsl(var(--foreground) / 0.08)',
          }}
        >
          ●
        </span>
      ))}
    </span>
  );
}

export interface Ciclo {
  organismo?: string;
  cpv?: string;
  proximo_estimado?: string;
  intervalo_medio_meses?: number;
  tendencia?: string;
  mes_tipico?: number;
  confianza?: string;
}

export interface ProyeccionesGridProps {
  rows: Ciclo[];
  emptyState?: React.ReactNode;
}

export function ProyeccionesGrid({ rows, emptyState }: ProyeccionesGridProps) {
  const data = React.useMemo(() => {
    return rows.map((c) => {
      const cpvCode = (c.cpv || '').replace('.0', '');
      const mesNum = c.mes_tipico || 0;
      const cicloId = btoa(unescape(encodeURIComponent((c.organismo || '') + '|' + cpvCode))).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
      const confLower = (c.confianza || 'baja').toLowerCase();
      const confMap: Record<string, number> = { baja: 1, media: 2, alta: 3 };
      return {
        _cicloId: cicloId,
        organismo: c.organismo || '—',
        cpv: cpvCode || '—',
        proximo: fmtProximo(c.proximo_estimado),
        proximo_fmt: fmtProximo(c.proximo_estimado),
        proximo_raw: parseProximo(c.proximo_estimado),
        intervalo: c.intervalo_medio_meses ? Math.round(c.intervalo_medio_meses) + ' meses' : '—',
        intervalo_fmt: c.intervalo_medio_meses ? Math.round(c.intervalo_medio_meses) + ' meses' : '—',
        intervalo_raw: c.intervalo_medio_meses != null ? Number(c.intervalo_medio_meses) : null,
        tendencia: c.tendencia || '—',
        mes: mesNum > 0 && mesNum <= 12 ? MES[mesNum] : '—',
        mes_fmt: mesNum > 0 && mesNum <= 12 ? MES[mesNum] : '—',
        mes_raw: mesNum || null,
        confianzaRender: dots(c.confianza),
        confianza: c.confianza || 'baja',
        confianza_raw: confMap[confLower] ?? 1,
      };
    });
  }, [rows]);

  const cols = React.useMemo((): Column[] => {
    return columns.map((c) =>
      c.key === 'confianza'
        ? { ...c, render: (_: any, row: any) => row.confianzaRender }
        : c
    );
  }, []);

  return (
    <DataGrid
      columns={cols}
      data={data}
      density="compact"
      defaultSortKey="proximo_raw"
      defaultSortDir="desc"
      countLabel={(n) => `${n} predicciones`}
      onRowClick={(row) => { window.location.href = `/explorer/oportunidad/${row._cicloId}`; }}
      emptyState={emptyState}
      tableClassName="proyecciones-grid"
    />
  );
}
