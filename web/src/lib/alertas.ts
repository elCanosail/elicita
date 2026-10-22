import fs from 'fs';
import path from 'path';

// CPVs y competidores se cargan dinámicamente del perfil del usuario
let CLIENTE_CPVS: string[] = [];
let COMPETIDORES: { nombre: string; cpvs: string[]; organismo: string; importe: number }[] = [];

export interface Alerta {
  id: string;
  tipo: string;
  nivel: string;
  titulo: string;
  descripcion: string;
  organismo: string;
  oportunidad_id: string | null;
  importe: string | null;
  fecha: string;
  leida: boolean;
  accion: string | null;
  expediente?: string;
  url?: string;
}

interface Contrato {
  id: string;
  expediente: string;
  titulo: any;
  organismo: any;
  cpvs: string[];
  importe_licitacion: number;
  fecha_publicacion: string;
  fecha_fin_presentacion: string | null;
  estado: string;
  url_fuente: string;
}

function loadData(): { contratos: Contrato[]; lastUpdate: string | null } {
  try {
    const tedFile = path.join(process.cwd(), '..', 'ingesta', 'data', 'ted_contracts.json');
    const ted = JSON.parse(fs.readFileSync(tedFile, 'utf-8'));
    return { contratos: ted.contratos || [], lastUpdate: ted.ultima_actualizacion };
  } catch (e) {
    console.error('Error loading TED data:', e);
    return { contratos: [], lastUpdate: null };
  }
}

function extractText(val: any): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    const found = val.find((item: any) => {
      const lang = item?.['@language']?.toLowerCase() || item?.['@xml:lang']?.toLowerCase();
      return lang?.startsWith('spa');
    });
    if (found) return extractText(found);
    return extractText(val[0]);
  }
  if (typeof val === 'object') {
    if (val['#text']) return val['#text'];
    if (val['spa']) return String(val['spa']);
    return JSON.stringify(val);
  }
  return String(val);
}

/** Normaliza formatos como '2026-02-27+01:00' o '2023-11-23Z' a Date válido */
function parseDate(fechaStr: string): Date {
  if (!fechaStr) return new Date(NaN);
  // Si ya tiene 'T' es ISO estándar
  if (fechaStr.includes('T')) return new Date(fechaStr);
  // Formato: YYYY-MM-DD seguido de Z o ±HH:MM
  // Regex: captura la parte de fecha (YYYY-MM-DD) y el offset/Z por separado
  const m = fechaStr.match(/^(\d{4}-\d{2}-\d{2})(Z|[+-]\d{2}:\d{2})?$/);
  if (m) {
    const iso = m[2] ? `${m[1]}T00:00:00${m[2]}` : `${m[1]}T00:00:00Z`;
    return new Date(iso);
  }
  return new Date(fechaStr);
}

function formatFechaRelativa(fechaStr: string): string {
  const fecha = parseDate(fechaStr);
  const ahora = new Date();
  const diffMs = ahora.getTime() - fecha.getTime();
  const diffHoras = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffHoras < 1) return 'Hace minutos';
  if (diffHoras < 24) return `Hace ${diffHoras}h`;
  if (diffDias === 1) return 'Ayer';
  if (diffDias < 7) return `Hace ${diffDias} días`;
  return fecha.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

function formatImporte(importe: number): string {
  if (!importe || importe === 0) return '—';
  if (importe >= 1000000) return `€ ${(importe / 1000000).toFixed(2)}M`;
  return `€ ${importe.toLocaleString('es-ES')}`;
}

export function generarAlertas(contratos: Contrato[]): Alerta[] {
  const alertas: Alerta[] = [];
  const ahora = new Date();
  const hace48h = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000); // Ventana de 7 días para contratos TED
  const dentro30dias = new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000);
  let counter = 1;

  // 1. Publicaciones recientes (últimas 48h) que coinciden con CPVs del cliente
  const publicacionesRecientes = contratos.filter(c => {
    if (!c.fecha_publicacion) return false;
    const fechaPub = parseDate(c.fecha_publicacion);
    return fechaPub >= hace48h && c.cpvs?.some(cpv => CLIENTE_CPVS.includes(cpv));
  });

  publicacionesRecientes.forEach(c => {
    const organismo = extractText(c.organismo) || 'Organismo no especificado';
    const titulo = extractText(c.titulo) || 'Sin título';
    const cpvMatch = c.cpvs?.find(cpv => CLIENTE_CPVS.includes(cpv));
    const esIncumbente = organismo.toLowerCase().includes('metro') || organismo.toLowerCase().includes('adif');

    alertas.push({
      id: `ALT-${String(counter++).padStart(3, '0')}`,
      tipo: 'publicacion',
      nivel: esIncumbente ? 'critica' : 'alta',
      titulo: esIncumbente ? 'Licitación publicada — contrato incumbente' : 'Nueva licitación relevante detectada',
      descripcion: `${organismo} ha publicado el expediente ${c.expediente} sobre "${titulo.slice(0, 100)}...". ${cpvMatch ? 'CPV compatible con perfil del cliente.' : ''}`,
      organismo,
      oportunidad_id: c.id,
      importe: formatImporte(c.importe_licitacion),
      fecha: formatFechaRelativa(c.fecha_publicacion),
      leida: false,
      accion: 'Ver pliego',
      expediente: c.expediente,
      url: c.url_fuente,
    });
  });

  // 2. Vencimientos próximos (< 30 días)
  const vencimientosProximos = contratos.filter(c => {
    if (!c.fecha_fin_presentacion) return false;
    const fechaFin = parseDate(c.fecha_fin_presentacion);
    return fechaFin <= dentro30dias && fechaFin > ahora &&
           c.cpvs?.some(cpv => CLIENTE_CPVS.includes(cpv));
  });

  vencimientosProximos.forEach(c => {
    const organismo = extractText(c.organismo) || 'Organismo no especificado';
    const titulo = extractText(c.titulo) || 'Sin título';
    const diasRestantes = Math.ceil((parseDate(c.fecha_fin_presentacion!).getTime() - ahora.getTime()) / (1000 * 60 * 60 * 24));

    alertas.push({
      id: `ALT-${String(counter++).padStart(3, '0')}`,
      tipo: 'vencimiento',
      nivel: diasRestantes < 7 ? 'critica' : 'alta',
      titulo: `Ventana crítica — ${diasRestantes} días para presentación`,
      descripcion: `El expediente ${c.expediente} de ${organismo} cierra su plazo el ${new Date(c.fecha_fin_presentacion!).toLocaleDateString('es-ES')}. Objeto: ${titulo.slice(0, 80)}...`,
      organismo,
      oportunidad_id: c.id,
      importe: formatImporte(c.importe_licitacion),
      fecha: formatFechaRelativa(c.fecha_fin_presentacion!),
      leida: false,
      accion: 'Ver oportunidad',
      expediente: c.expediente,
      url: c.url_fuente,
    });
  });

  // 3. Competencia (simulada sobre contratos recientes con CPVs coincidentes)
  const contratosRecientes = contratos.filter(c => {
    if (!c.fecha_publicacion) return false;
    return parseDate(c.fecha_publicacion) >= new Date(ahora.getTime() - 30 * 24 * 60 * 60 * 1000);
  });

  COMPETIDORES.forEach((comp, idx) => {
    const matches = contratosRecientes
      .filter(c => c.cpvs?.some(cpv => comp.cpvs.includes(cpv)))
      .slice(0, 2);

    matches.forEach(c => {
      const organismo = extractText(c.organismo) || 'Organismo no especificado';
      const descuento = (8 + Math.random() * 5).toFixed(1);
      alertas.push({
        id: `ALT-${String(counter++).padStart(3, '0')}`,
        tipo: 'competencia',
        nivel: idx === 0 ? 'media' : 'baja',
        titulo: `${comp.nombre} adjudicado en contrato similar`,
        descripcion: `${comp.nombre} ha sido adjudicado con ${organismo} por ${formatImporte(comp.importe)}. Baja aplicada: ${descuento}%. Refuerza su posición en este segmento.`,
        organismo: comp.organismo,
        oportunidad_id: c.id,
        importe: formatImporte(comp.importe),
        fecha: formatFechaRelativa(c.fecha_publicacion),
        leida: false,
        accion: 'Ver competencia',
      });
    });
  });

  // 4. Alerta de sistema
  alertas.push({
    id: `ALT-${String(counter++).padStart(3, '0')}`,
    tipo: 'sistema',
    nivel: 'baja',
    titulo: 'Actualización del dataset completada',
    descripcion: `El sistema ha procesado ${contratos.length} contratos de TED. Se han generado ${alertas.filter(a => a.tipo !== 'sistema').length} alertas automáticas basadas en el perfil del cliente.`,
    organismo: 'Sistema elicita_',
    oportunidad_id: null,
    importe: null,
    fecha: 'Hace 3 días',
    leida: true,
    accion: null,
  });

  return alertas;
}

export async function generarAlertasSSR(): Promise<Alerta[]> {
  const { contratos } = loadData();
  return generarAlertas(contratos);
}
