import type { APIRoute } from 'astro';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../../../lib/api-auth';

function loadDemoData() {
  const demoDir = path.join(process.cwd(), '..', 'ingesta', 'data', 'demo');
  try {
    const raw = fs.readFileSync(path.join(demoDir, 'demo_contracts.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { ultima_actualizacion: null, contratos: [] };
  }
}

function formatImporte(importe: number): string {
  if (importe >= 1000000) return `${(importe / 1000000).toFixed(2)}M €`;
  if (importe >= 1000) return `${(importe / 1000).toFixed(0)}K €`;
  return `${importe} €`;
}

function normalizeContract(c: any) {
  return {
    id: c.id,
    fuente: c.fuente || 'DEMO',
    organismo: c.organismo,
    objeto: (c.titulo || 'Sin título').slice(0, 120),
    cpv: c.cpvs?.[0] || '—',
    importe: c.importe_licitacion ? formatImporte(c.importe_licitacion) : '—',
    importe_num: c.importe_licitacion || 0,
    fecha_publicacion: c.fecha_publicacion?.slice(0, 10),
    fecha_fin: c.fecha_fin_presentacion?.slice(0, 10),
    dias: c.fecha_fin_presentacion
      ? Math.max(0, Math.floor((new Date(c.fecha_fin_presentacion).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : null,
    url: c.url_fuente || '#demo',
    score: c.score || 70,
    propia: c.propia || false,
    incumbente: c.incumbente || '—',
    baja_historica: c.baja_historica || null,
    renovacion: c.renovacion || null,
    estado: c.estado || 'abierta',
  };
}

export const GET: APIRoute = async ({ url, locals }) => {
  const { error } = requireAuth(locals);
  if (error) return error;
  const data = loadDemoData();
  const tipo = url.searchParams.get('tipo') || 'pipeline';
  const rawContratos: any[] = data.contratos || [];

  let contratos = rawContratos.map(normalizeContract);

  if (tipo === 'pipeline') {
    contratos = contratos
      .filter((c: any) => c.estado === 'abierta')
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 20);
  }

  if (tipo === 'renovaciones') {
    contratos = contratos
      .filter((c: any) => c.renovacion === true)
      .sort((a: any, b: any) => b.score - a.score);
  }

  if (tipo === 'mercado') {
    const porCpv: { [key: string]: { cpv: string; total: number; importe: number } } = {};
    rawContratos.forEach((c: any) => {
      const cpv = c.cpvs?.[0] || '—';
      if (!porCpv[cpv]) porCpv[cpv] = { cpv, total: 0, importe: 0 };
      porCpv[cpv].total++;
      porCpv[cpv].importe += c.importe_licitacion || 0;
    });
    return new Response(JSON.stringify({
      ultima_actualizacion: data.ultima_actualizacion,
      total: rawContratos.length,
      cpvs: Object.values(porCpv).sort((a: any, b: any) => b.importe - a.importe),
      demo: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    ultima_actualizacion: data.ultima_actualizacion,
    fuente: 'DEMO — Datos ficticios',
    total: contratos.length,
    contratos,
    demo: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
