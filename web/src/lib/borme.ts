/**
 * Lógica pura BORME (Registro Mercantil) — compartida por /perfil/[nif].
 *
 * Resolución NIF → BORME (fase 1 del plan BORME 2026-10-14):
 *   nif → nif_canonical.nombre (fallback: adjudicatario de contratos_vivos)
 *       → empresa_norm exacta (equality sobre clave de comparación, NO LIKE
 *       a ciegas).
 *
 * Esquema de datos: borme_empresas (una fila por empresa/entrada BORME-A),
 * borme_cargos (una fila por acto de cargo), borme_personas (persona_hash →
 * nombre, filas nuevas desde la ingesta XML diaria de 2026-10; los históricos
 * upstream son opacos). persona_hash = sha256('borme_2024:' + NOMBRE)[:16]
 * (esquema upstream verificado).
 *
 * El espejo CJS para el reporte semanal vive en ingesta/lib/borme-actos.js —
 * mantiene las mismas reglas (tests espejo en ambos lados).
 */

/** Fila relevante de borme_empresas (ya serializada a strings/numbers). */
export interface BormeEmpRow {
  fecha_borme: string | null;
  num_entrada: string | null;
  empresa: string | null;
  empresa_norm: string | null;
  provincia: string | null;
  actos: string | null;
  domicilio: string | null;
  capital_euros: number | null;
  fecha_constitucion: string | null;
  hoja_registral: string | null;
  tomo: string | null;
  inscripcion: string | null;
  fecha_inscripcion: string | null;
  pdf_filename: string | null;
}

/** Fila relevante de borme_cargos. */
export interface BormeCargoRow {
  fecha_borme: string | null;
  num_entrada: string | null;
  empresa_norm: string | null;
  tipo_acto: string | null;
  cargo: string | null;
  persona_hash: string | null;
  pdf_filename: string | null;
}

const SUFICIOS = new Set([
  'SL', 'SLU', 'SLE', 'SLP', 'SLL', 'SA', 'SAU', 'SAP', 'SC', 'SCA', 'SCL',
  'CB', 'AIE', 'UTE', 'SGR', 'EIRELL',
  'SOCIEDADLIMITADA', 'SOCIEDADANONIMA', 'SOCIEDADLABORAL', 'SOCIEDADCIVIL',
  'SOCIEDADCOMANDITARIA', 'COMANDITARIAPORACCIONES', 'COMANDITARIA',
  // sufijos multi-palabra del boletín ('… SOCIEDAD LIMITADA') y de segmentos
  // pegados por coma ('OCTAPHARMA,S.A.'), calibrado contra pares reales:
  'SOCIEDAD', 'LIMITADA', 'ANONIMA', 'LABORAL', 'CIVIL', 'COMANDITARIA',
  'COOPERATIVA', 'POR', 'ACCIONES', 'SCOOP', 'COOP', 'SRL', 'SRLU',
]);

/** Núcleo alfanumérico de un token (para comparar 'S.L.' ≡ 'SL'). */
function coreTok(tok: string): string {
  return tok.replace(/[^A-Z0-9ÑÁÉÍÓÚÜ]/g, '');
}

/**
 * Réplica de la regla upstream de `empresa_norm` (calibrada contra pares
 * reales del parquet v2026.10): mayúsculas, colapsar espacios, recorte de
 * sufijos societarios finales. Upstream NO recorta cuando el nombre trae
 * anotación posterior ('SL. SOCIEDAD UNIPERSONAL'). Conserva acentos, comas
 * y puntos.
 */
export function normalizeBormeName(name: string): string {
  const up = (name || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!up) return '';
  if (/UNIPERSONAL/.test(up)) return up;
  // Sufijos pegados por coma ('OCTAPHARMA,S.A.', 'FAES FARMA, S.L.U.', y la
  // coma final '… GENERAL S.L.,'): recorta segmentos finales cuyo núcleo sea
  // sufijo; segmentos vacíos (coma final) se descartan antes.
  const parts = up.split(',').filter((p) => p.trim() !== '');
  while (parts.length > 1 && SUFICIOS.has(coreTok(parts[parts.length - 1]))) parts.pop();
  const base = parts.join(',');
  // Sufijos finales por token ('… SOCIEDAD LIMITADA', '… SL', '… SA').
  const tokens = base.split(' ');
  const out = [...tokens];
  while (out.length > 1 && SUFICIOS.has(coreTok(out[out.length - 1]))) out.pop();
  return out.join(' ');
}

/**
 * Clave de comparación NIF↔BORME: todo lo que no es letra/número fuera
 * (comas y puntos de 'EMPRESA, S.A.', espacios, guiones). Igualdad exacta
 * sobre esta clave = match determinista sin LIKE a ciegas. En SQL se aplica
 * con regexp_replace(empresa_norm, '[^A-Za-z0-9ÑÁÉÍÓÚÜñáéíóúü]', '', 'g').
 */
export function bormeMatchKey(name: string): string {
  return normalizeBormeName(name).replace(/[^A-Z0-9ÑÁÉÍÓÚÜ]/g, '');
}

/**
 * URL del PDF oficial del boletín en boe.es a partir de pdf_filename y la
 * fecha de publicación de la fila: BORME-A-2009-21-28.pdf con fecha
 * 2009-02-02 → https://www.boe.es/borme/dias/2009/02/02/pdfs/BORME-A-2009-21-28.pdf
 */
export function bormePdfUrl(
  pdfFilename: string | null | undefined,
  fechaBorme: string | null | undefined,
): string | null {
  if (!pdfFilename || !fechaBorme) return null;
  const f = String(fechaBorme);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f);
  if (!m) return null;
  if (!/^BORME-[A-Z]-/.test(pdfFilename)) return null;
  return `https://www.boe.es/borme/dias/${m[1]}/${m[2]}/${m[3]}/pdfs/${pdfFilename}`;
}

/** Serializa fecha DuckDB (Date | 'YYYY-MM-DD…' | 'DD.MM.YY[.]') a ISO. */
export function parseBormeFecha(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2})\.?$/.exec(s);
  if (m) {
    const yy = parseInt(m[3], 10);
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

export interface BormeActoItem {
  /** tipo de acto tal como aparece en el boletín ('Nombramientos', …). */
  tipo: string;
  cargo?: string;
  persona?: string | null;
  personaHash?: string | null;
}

export interface BormeDia {
  fecha: string;
  pdfUrl: string | null;
  /** Actos de cargo (nombramientos, ceses…) con persona cuando es conocida. */
  cargos: BormeActoItem[];
  /** Resto de actos del día (modificaciones, capital…), texto plano. */
  otros: string[];
}

export interface BormeFicha {
  empresa: string | null;
  domicilio: string | null;
  capital_euros: number | null;
  fecha_constitucion: string | null;
  provincia: string | null;
  hoja_registral: string | null;
  tomo: string | null;
  inscripcion: string | null;
  fecha_inscripcion: string | null;
  ultima_inscripcion: string | null;
}

export interface BormeTimeline {
  ficha: BormeFicha;
  dias: BormeDia[];
  /** Nº total de fechas distintas con actos (dias puede estar truncado). */
  totalDias: number;
}

const LABEL_OTROS: Record<string, string> = {
  nombramiento: 'Nombramientos',
  reeleccion: 'Reelecciones',
  revocacion: 'Revocacion',
  cese: 'Ceses/Dimisiones',
  cancelacion: 'Cancelaciones',
};

/** tipo_acto upstream (singular, sin acentos) → cabecera plural del boletín. */
function labelDeTipo(tipo: string | null | undefined): string {
  if (!tipo) return 'Acto inscribible';
  return LABEL_OTROS[tipo.toLowerCase()] || tipo.charAt(0).toUpperCase() + tipo.slice(1);
}

/**
 * Une borme_empresas + borme_cargos en un timeline agrupado por fecha desc.
 * - Cargos primero (tipo_acto, cargo, persona resuelta vía `personas`).
 * - Los actos 'otros' salen de la columna actos de empresas (cabeceras
 *   separadas por '|'), sin duplicar los tipos ya representados por cargos.
 * - Sin filas → null (el perfil no pinta la sección).
 */
export function buildBormeTimeline(
  empRows: BormeEmpRow[],
  cargoRows: BormeCargoRow[],
  personas: Map<string, string> = new Map(),
  opts: { maxDias?: number } = {},
): BormeTimeline | null {
  const maxDias = opts.maxDias ?? 25;
  if ((!empRows || !empRows.length) && (!cargoRows || !cargoRows.length)) return null;

  // ── ficha: último valor no nulo recorriendo fecha desc ──────────────────
  const empSorted = [...(empRows || [])].sort((a, b) =>
    String(b.fecha_borme || '').localeCompare(String(a.fecha_borme || '')),
  );
  const pick = <T>(get: (r: BormeEmpRow) => T): T | null => {
    for (const r of empSorted) {
      const v = get(r);
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
  };
  const ficha: BormeFicha = {
    empresa: pick((r) => r.empresa),
    domicilio: pick((r) => r.domicilio),
    capital_euros: pick((r) => r.capital_euros),
    fecha_constitucion: pick((r) => r.fecha_constitucion),
    provincia: pick((r) => r.provincia),
    hoja_registral: pick((r) => r.hoja_registral),
    tomo: pick((r) => r.tomo),
    inscripcion: pick((r) => r.inscripcion),
    fecha_inscripcion: pick((r) => r.fecha_inscripcion),
    ultima_inscripcion: empSorted.length ? parseBormeFecha(empSorted[0].fecha_borme) : null,
  };

  // ── agrupar cargos por fecha ────────────────────────────────────────────
  const cargosPorFecha = new Map<string, BormeActoItem[]>();
  for (const r of cargoRows || []) {
    const fecha = parseBormeFecha(r.fecha_borme);
    if (!fecha) continue;
    let list = cargosPorFecha.get(fecha);
    if (!list) {
      list = [];
      cargosPorFecha.set(fecha, list);
    }
    list.push({
      tipo: labelDeTipo(r.tipo_acto),
      cargo: r.cargo || undefined,
      persona: r.persona_hash ? personas.get(r.persona_hash) || null : null,
      personaHash: r.persona_hash || null,
    });
  }
  for (const list of cargosPorFecha.values()) {
    list.sort((a, b) => (a.cargo || '').localeCompare(b.cargo || ''));
  }

  // ── actos «otros» por fecha (cabeceras sin cargos asociados) ────────────
  const cabeceraDeTipo = new Map<string, number>();
  for (const items of cargosPorFecha.values()) {
    for (const it of items) {
      const key = it.tipo.toLowerCase();
      cabeceraDeTipo.set(key, (cabeceraDeTipo.get(key) || 0) + 1);
    }
  }
  const otrosPorFecha = new Map<string, string[]>();
  const pdfPorFecha = new Map<string, string | null>();
  for (const r of empRows || []) {
    const fecha = parseBormeFecha(r.fecha_borme);
    if (!fecha) continue;
    if (r.pdf_filename && !pdfPorFecha.has(fecha)) {
      pdfPorFecha.set(fecha, bormePdfUrl(r.pdf_filename, r.fecha_borme));
    }
    if (!r.actos) continue;
    const headers = String(r.actos).split('|').map((s) => s.trim()).filter(Boolean);
    const otros = otrosPorFecha.get(fecha) || [];
    for (const h of headers) {
      const consumidos = cabeceraDeTipo.get(h.toLowerCase()) || 0;
      if (consumidos > 0) {
        cabeceraDeTipo.set(h.toLowerCase(), consumidos - 1);
        continue; // este tipo ya se muestra con detalle (cargo+persona)
      }
      if (!otros.includes(h)) otros.push(h);
    }
    otrosPorFecha.set(fecha, otros);
  }

  // ── merge de fechas, orden desc, truncado ───────────────────────────────
  const fechas = new Set<string>([...cargosPorFecha.keys(), ...otrosPorFecha.keys()]);
  const ordenadas = [...fechas].sort((a, b) => b.localeCompare(a));
  const dias: BormeDia[] = ordenadas.slice(0, maxDias).map((fecha) => ({
    fecha,
    pdfUrl: pdfPorFecha.get(fecha) ?? null,
    cargos: cargosPorFecha.get(fecha) || [],
    otros: otrosPorFecha.get(fecha) || [],
  }));
  return { ficha, dias, totalDias: ordenadas.length };
}
