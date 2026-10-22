import * as React from "react";
import { DataGrid, type Column } from "../DataGrid";

const CPV_SECTORS: { code: string; label: string }[] = [
  { code: '03', label: 'Agricultura' },
  { code: '09', label: 'Petróleo/Gas' },
  { code: '14', label: 'Minería' },
  { code: '15', label: 'Alimentación' },
  { code: '16', label: 'Agricultura machinery' },
  { code: '18', label: 'Indumentaria' },
  { code: '19', label: 'Combustibles' },
  { code: '24', label: 'Química' },
  { code: '30', label: 'Informática' },
  { code: '31', label: 'Electrónica' },
  { code: '32', label: 'Telecomunicaciones' },
  { code: '33', label: 'Equipo óptico' },
  { code: '34', label: 'Transporte' },
  { code: '35', label: 'Energía' },
  { code: '37', label: 'Construcción civil' },
  { code: '38', label: 'Construcción' },
  { code: '39', label: 'Maquinaria' },
  { code: '41', label: 'Agua' },
  { code: '42', label: 'Ingeniería civil' },
  { code: '43', label: 'Trabajos construcción' },
  { code: '44', label: 'Materiales' },
  { code: '45', label: 'Construcción general' },
  { code: '48', label: 'Equipamiento' },
  { code: '50', label: 'Reparaciones' },
  { code: '51', label: 'Instalaciones' },
  { code: '52', label: 'Ingeniería' },
  { code: '55', label: 'Hostelería' },
  { code: '59', label: 'Software/IT' },
  { code: '60', label: 'Transporte' },
  { code: '63', label: 'Servicios viaje' },
  { code: '64', label: 'Correos' },
  { code: '65', label: 'Seguros' },
  { code: '66', label: 'Finanzas' },
  { code: '67', label: 'Servicios financieros' },
  { code: '70', label: 'Inmobiliaria' },
  { code: '71', label: 'Arquitectura/Ingeniería' },
  { code: '72', label: 'SIT/Telecom' },
  { code: '73', label: 'I+D' },
  { code: '75', label: 'Adm. pública' },
  { code: '76', label: 'Defensa' },
  { code: '77', label: 'Alquiler' },
  { code: '79', label: 'Seguridad' },
  { code: '80', label: 'Educación' },
  { code: '85', label: 'Sanidad' },
  { code: '90', label: 'Medio ambiente' },
  { code: '92', label: 'Cultura/Deporte' },
  { code: '98', label: 'Otros servicios' },
  { code: '99', label: 'Otros' },
];

function fmtVolumen(v?: number) {
  if (v === undefined || v === null) return '—';
  const n = Number(v);
  if (n >= 1000000000) return (n / 1000000000).toFixed(1).replace('.0', '') + 'B €';
  if (n >= 1000000)    return (n / 1000000).toFixed(1).replace('.0', '') + 'M €';
  if (n >= 1000)       return (n / 1000).toFixed(0) + 'K €';
  return n.toFixed(0) + ' €';
}

function badgeProb(prob?: string) {
  const p = (prob || 'baja').toLowerCase();
  const cls = p === 'alta' ? 'badge-alta' : p === 'media' ? 'badge-media' : 'badge-baja';
  return <span className={`badge-prob ${cls}`}>{p}</span>;
}

export interface Oportunidad {
  organismo?: string;
  cpv?: string;
  num_contratos?: number;
  volumen_eur?: number;
  prob_entrada?: string;
  tasa_rotacion_pct?: number;
}

export interface OportunidadesMercadoGridProps {
  rows: Oportunidad[];
}

const columns: Column[] = [
  { key: 'organismo', label: 'Organismo', sortable: true, width: '30%' },
  { key: 'cpv', label: 'CPV', sortable: true, mono: true, width: '12%' },
  { key: 'num_contratos', label: 'Contratos', sortable: true, align: 'right', mono: true, width: '11%', sortKey: 'num_contratos_raw' },
  { key: 'volumen_eur', label: 'Volumen', sortable: true, align: 'right', mono: true, width: '15%', sortKey: 'volumen_eur_raw', render: (_: any, row: any) => row.volumen_eur_fmt },
  { key: 'prob_entrada', label: 'Prob. entrada', sortable: true, align: 'center', width: '14%' },
  { key: 'tasa_rotacion_pct', label: 'Rotación', sortable: true, align: 'right', mono: true, width: '10%', sortKey: 'tasa_rotacion_pct_raw' },
];

export function OportunidadesMercadoGrid({ rows }: OportunidadesMercadoGridProps) {
  const [searchText, setSearchText] = React.useState('');
  const [sectorFilter, setSectorFilter] = React.useState<string>('');
  const [showFilters, setShowFilters] = React.useState(false);

  const filteredRows = React.useMemo(() => {
    let result = rows;
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      result = result.filter(r => (r.organismo || '').toLowerCase().includes(q));
    }
    if (sectorFilter) {
      result = result.filter(r => (r.cpv || '').replace('.0', '').startsWith(sectorFilter));
    }
    return result;
  }, [rows, searchText, sectorFilter]);

  const data = React.useMemo(() => {
    return filteredRows.map((r) => ({
      organismo: r.organismo || '—',
      cpv: (r.cpv || '').replace('.0', '') || '—',
      num_contratos_raw: r.num_contratos != null ? Number(r.num_contratos) : null,
      num_contratos: r.num_contratos != null ? Number(r.num_contratos).toLocaleString('es-ES') : '—',
      volumen_eur_raw: r.volumen_eur != null ? Number(r.volumen_eur) : null,
      volumen_eur: fmtVolumen(r.volumen_eur),
      volumen_eur_fmt: fmtVolumen(r.volumen_eur),
      prob_entrada: r.prob_entrada || 'baja',
      probRender: badgeProb(r.prob_entrada),
      tasa_rotacion_pct_raw: r.tasa_rotacion_pct != null ? Number(r.tasa_rotacion_pct) : null,
      tasa_rotacion_pct: r.tasa_rotacion_pct != null ? Number(r.tasa_rotacion_pct).toFixed(1) + '%' : '—',
    }));
  }, [filteredRows]);

  const cols = React.useMemo((): Column[] => {
    return columns.map((c) =>
      c.key === 'prob_entrada'
        ? { ...c, render: (_: any, row: any) => row.probRender }
        : c
    );
  }, []);

  const sectorLabel = sectorFilter
    ? CPV_SECTORS.find(s => s.code === sectorFilter)?.label || sectorFilter
    : '';

  const hasActiveFilters = searchText.trim() || sectorFilter;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="opm-filters-bar">
        <button
          className={`opm-filter-toggle${showFilters ? ' active' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
        >
          ⚙ Filtros{hasActiveFilters ? ` (${[searchText.trim() && 'texto', sectorFilter && sectorLabel].filter(Boolean).join(' · ')})` : ''}
        </button>
        {hasActiveFilters && (
          <button className="opm-filter-clear" onClick={() => { setSearchText(''); setSectorFilter(''); }}>
            ✕ Limpiar
          </button>
        )}
        <span className="opm-filter-count">
          {filteredRows.length} de {rows.length} oportunidades
        </span>
      </div>
      {showFilters && (
        <div className="opm-filters-panel">
          <input
            type="text"
            className="opm-filter-input"
            placeholder="Buscar organismo…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <select
            className="opm-filter-select"
            value={sectorFilter}
            onChange={(e) => setSectorFilter(e.target.value)}
          >
            <option value="">Sector: Todos</option>
            {CPV_SECTORS.map(s => (
              <option key={s.code} value={s.code}>{s.code} — {s.label}</option>
            ))}
          </select>
        </div>
      )}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <DataGrid
          columns={cols}
          data={data}
          density="comfortable"
          defaultSortKey="volumen_eur_raw"
          defaultSortDir="desc"
          countLabel={(n) => `${n} oportunidades · organismos donde no eres incumbente`}
          tableClassName="oportunidades-mercado-grid"
        />
      </div>
    </div>
  );
}
