import * as React from "react";
import { DataGrid, type Column } from "../DataGrid";

function fmtVolumen(v?: number) {
  if (v === undefined || v === null) return '—';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M€';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K€';
  return v.toFixed(0) + '€';
}

function scoreColor(s?: number | null) {
  if (s == null) return 'hsl(var(--muted-foreground))';
  if (s > 85) return 'hsl(var(--primary))';
  if (s > 70) return 'hsl(var(--warning))';
  return 'hsl(var(--destructive))';
}

export interface Competidor {
  nombre: string;
  nif: string;
  coincidencias: number;
  score?: number | null;
  total?: number;
  volumen: number;
  cpvs_comunes: string[];
  cpvNames?: Record<string, string | undefined>;
}

export interface CompetidoresGridProps {
  rows: Competidor[];
  emptyState?: React.ReactNode;
}

const columns: Column[] = [
  { key: 'nombre', label: 'Empresa', sortable: true, width: '32%' },
  { key: 'coincidencias', label: 'Coincidencias', sortable: true, align: 'right', mono: true, width: '14%' },
  { key: 'score', label: 'Calidad', sortable: true, align: 'right', width: '12%' },
  { key: 'volumen', label: 'Volumen', sortable: true, align: 'right', mono: true, width: '14%' },
  { key: 'cpvs', label: 'CPVs comunes', sortable: false, width: '28%' },
];

function CPVChips({ row }: { row: any }) {
  const cpvs: string[] = row._cpvList || [];
  const names: Record<string, string | undefined> = row._cpvNames || {};
  return (
    <div className="cpv-chips">
      {cpvs.map((code: string) => {
        const name = names[code];
        const label = name ? name.replace(/\.$/, '').slice(0, 30) + (name.length > 30 ? '…' : '') : code;
        return <span key={code} className="cpv-chip" title={name || code}>{label}</span>;
      })}
    </div>
  );
}

export function CompetidoresGrid({ rows, emptyState }: CompetidoresGridProps) {
  const data = React.useMemo(() => {
    return rows.map((c) => ({
      _nif: c.nif,
      nombre: (
        <>
          <div className="comp-name">{c.nombre}</div>
          <div className="comp-nif">{c.nif}</div>
        </>
      ),
      coincidencias: c.coincidencias != null ? c.coincidencias.toLocaleString('es-ES') : '—',
      _coincidenciasNum: c.coincidencias || 0,
      score: c.score !== null && c.score !== undefined ? c.score : null,
      _scoreNum: c.score !== null && c.score !== undefined ? c.score : 0,
      scoreRender: c.score !== null && c.score !== undefined ? (
        <span
          className="score-badge"
          style={{ color: scoreColor(c.score), borderColor: scoreColor(c.score) + '44' }}
          title={`${(c.total || 0).toLocaleString('es-ES')} contratos analizados`}
        >
          {c.score}
        </span>
      ) : (
        <span className="score-null">—</span>
      ),
      volumen: fmtVolumen(c.volumen),
      _volumenNum: c.volumen || 0,
      cpvsRender: <CPVChips row={{ _cpvList: (c.cpvs_comunes || []).slice(0, 4), _cpvNames: c.cpvNames }} />,
    }));
  }, [rows]);

  const cols = React.useMemo((): Column[] => {
    return columns.map((c) => {
      if (c.key === 'nombre') return { ...c, render: (_: any, row: any) => row.nombre };
      if (c.key === 'score') return { ...c, sortKey: '_scoreNum', render: (_: any, row: any) => row.scoreRender };
      if (c.key === 'volumen') return { ...c, sortKey: '_volumenNum', render: (_: any, row: any) => row.volumen };
      if (c.key === 'coincidencias') return { ...c, sortKey: '_coincidenciasNum', render: (_: any, row: any) => row.coincidencias };
      if (c.key === 'cpvs') return { ...c, render: (_: any, row: any) => row.cpvsRender };
      return c;
    });
  }, []);

  return (
    <DataGrid
      columns={cols}
      data={data}
      density="comfortable"
      defaultSortKey="_volumenNum"
      defaultSortDir="desc"
      countLabel={(n) => `${n} competidores`}
      onRowClick={(row) => { window.location.href = `/explorer/competidores/${row._nif}`; }}
      emptyState={emptyState}
      tableClassName="competidores-grid"
    />
  );
}
