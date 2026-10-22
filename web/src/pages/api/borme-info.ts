import type { APIRoute } from 'astro';
import { query } from '../../lib/duckdb';
import { requireAuth } from '../../lib/api-auth';

function fmtDate(v: any): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (s === '') return undefined;
  const match = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (match) {
    let [_, d, m, y] = match;
    let year = parseInt(y, 10);
    if (year < 50) year += 2000;
    else if (year < 100) year += 1900;
    const dd = d.padStart(2, '0');
    const mm = m.padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function toNum(v: any): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeName(name: string): string {
  return name
    .replace(/,/g, '')
    .replace(/\./g, '')
    .replace(/\bS\.?L\.?U\.?\b/gi, '')
    .replace(/\bS\.?A\.?U\.?\b/gi, '')
    .replace(/\bS\.?L\.?\b/gi, '')
    .replace(/\bS\.?A\.?\b/gi, '')
    .replace(/\bS\.?C\.?\b/gi, '')
    .replace(/\bS\.?L\.?P\.?\b/gi, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s: string): string {
  if (!s) return s;
  const lowerSet = new Set(['y', 'e', 'de', 'del', 'la', 'las', 'los', 'el', 'en', 'con', 'para', 'por']);
  return s.split(/(\s+|,\s*)/).map((word, i) => {
    if (/^(S\.?L\.?U?\.?|S\.?A\.?U?\.?|S\.?C\.?|S\.?L\.?P\.?|U\.?T\.?E\.?|A\.?I\.?E\.?)$/i.test(word))
      return word.toUpperCase();
    if (/^\s+$/.test(word) || /^,/.test(word)) return word;
    const w = word.toLowerCase();
    if (i > 0 && lowerSet.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}

interface BormeInfo {
  domicilio?: string;
  capital_euros?: number;
  fecha_constitucion?: string;
  provincia?: string;
  hoja_registral?: string;
  tomo?: string;
  inscripcion?: string;
  fecha_inscripcion?: string;
}

interface CargoActivo {
  empresa: string;
  cargo: string;
  persona_hash: string;
  fecha_borme: string;
}

interface ActoReciente {
  fecha_borme: string;
  actos: string;
  tipo: string;
}

interface CachedEntry {
  data: {
    nif: string;
    nombre_canonico: string | null;
    verificado: boolean;
    borme: BormeInfo;
    cargos_activos: CargoActivo[];
    actos_recientes: ActoReciente[];
  };
  ts: number;
}

const CACHE = new Map<string, CachedEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

export const GET: APIRoute = async ({ url, locals }) => {
  const { error } = requireAuth(locals);
  if (error) return error;
  const nif = url.searchParams.get('nif')?.trim().toUpperCase() || '';
  if (!nif) {
    return new Response(JSON.stringify({ error: 'Parámetro requerido: nif' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cached = CACHE.get(nif);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return new Response(JSON.stringify(cached.data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
    });
  }

  try {
    // 1. Resolve canonical name from nif_canonical (may not exist — fallback to contracts)
    let nombreCanonico: string | null = null;
    try {
      const canonicalRows = await query(
        `SELECT nombre FROM nif_canonical WHERE nif = ? LIMIT 1`,
        [nif]
      );
      nombreCanonico = canonicalRows[0]?.nombre || null;
    } catch {
      // nif_canonical table may not exist — use fallback below
    }
    const verificado = !!nombreCanonico;

    // 2. Fallback to adjudicatario name from contracts if not in canonical table
    let companyName: string | null = null;
    if (!nombreCanonico) {
      const nameRows = await query(
        `SELECT DISTINCT adjudicatario
         FROM contratos_vivos
         WHERE nif_adjudicatario = ? AND adjudicatario IS NOT NULL
         LIMIT 1`,
        [nif]
      );
      companyName = nameRows[0]?.adjudicatario || null;
    }

    const displayName = nombreCanonico || companyName || nif;
    const bormeNorm = normalizeName(displayName);

    const bormeInfo: BormeInfo = {};
    const cargosActivos: CargoActivo[] = [];
    const actosRecientes: ActoReciente[] = [];

    if (bormeNorm) {
      // 3. BORME empresa data — prefer canonical match, then LIKE fallback
      let empRows: any[] = [];
      try {
      if (nombreCanonico) {
        empRows = await query(
          `SELECT empresa, empresa_norm, domicilio, capital_euros, fecha_constitucion,
                  provincia, hoja_registral, tomo, inscripcion, fecha_inscripcion,
                  actos, fecha_borme
           FROM borme_empresas
           WHERE empresa_norm = ?
           ORDER BY fecha_borme DESC
           LIMIT 50`,
          [bormeNorm]
        );
      }
      if (empRows.length === 0) {
        empRows = await query(
          `SELECT empresa, empresa_norm, domicilio, capital_euros, fecha_constitucion,
                  provincia, hoja_registral, tomo, inscripcion, fecha_inscripcion,
                  actos, fecha_borme
           FROM borme_empresas
           WHERE empresa_norm LIKE ?
           ORDER BY fecha_borme DESC
           LIMIT 50`,
          [`%${bormeNorm}%`]
        );
      }
      } catch { /* borme_empresas table may not exist */ }

      for (const r of empRows) {
        if (!bormeInfo.domicilio && r.domicilio) bormeInfo.domicilio = String(r.domicilio).trim();
        if (bormeInfo.capital_euros === undefined && r.capital_euros !== null && r.capital_euros !== undefined)
          bormeInfo.capital_euros = toNum(r.capital_euros);
        if (!bormeInfo.fecha_constitucion && r.fecha_constitucion)
          bormeInfo.fecha_constitucion = fmtDate(r.fecha_constitucion);
        if (!bormeInfo.provincia && r.provincia) bormeInfo.provincia = String(r.provincia).trim();
        if (!bormeInfo.hoja_registral && r.hoja_registral) bormeInfo.hoja_registral = String(r.hoja_registral).trim();
        if (!bormeInfo.tomo && r.tomo) bormeInfo.tomo = String(r.tomo).trim();
        if (!bormeInfo.inscripcion && r.inscripcion) bormeInfo.inscripcion = String(r.inscripcion).trim();
        if (!bormeInfo.fecha_inscripcion && r.fecha_inscripcion)
          bormeInfo.fecha_inscripcion = fmtDate(r.fecha_inscripcion);

        const actosText = r.actos ? String(r.actos) : '';
        if (actosText) {
          const tipo = inferTipoActo(actosText);
          actosRecientes.push({
            fecha_borme: fmtDate(r.fecha_borme) || '—',
            actos: titleCase(actosText),
            tipo,
          });
        }
      }

      // 4. BORME cargos
      let cargoRows: any[] = [];
      try {
      if (nombreCanonico) {
        cargoRows = await query(
          `SELECT empresa, tipo_acto, cargo, persona_hash, fecha_borme
           FROM borme_cargos
           WHERE empresa_norm = ?
           ORDER BY fecha_borme DESC
           LIMIT 500`,
          [bormeNorm]
        );
      }
      if (cargoRows.length === 0) {
        cargoRows = await query(
          `SELECT empresa, tipo_acto, cargo, persona_hash, fecha_borme
           FROM borme_cargos
           WHERE empresa_norm LIKE ?
           ORDER BY fecha_borme DESC
           LIMIT 500`,
          [`%${bormeNorm}%`]
        );
      }
      } catch { /* borme_cargos table may not exist */ }

      // Track active positions: latest nombramiento/revocación per (persona_hash, cargo)
      const latestCargo = new Map<string, { row: any; key: string }>();
      for (const r of cargoRows) {
        if (!r.persona_hash || !r.cargo) continue;
        const key = `${r.persona_hash}:${r.cargo}`;
        if (!latestCargo.has(key)) {
          latestCargo.set(key, { row: r, key });
        }
      }

      for (const { row: r } of latestCargo.values()) {
        const tipo = String(r.tipo_acto || '').toLowerCase();
        if (tipo.includes('nombramiento') || tipo.includes('reelección') || tipo.includes('renovación') || tipo.includes('designación')) {
          cargosActivos.push({
            empresa: titleCase(r.empresa) || r.empresa || displayName,
            cargo: String(r.cargo || '—'),
            persona_hash: String(r.persona_hash),
            fecha_borme: fmtDate(r.fecha_borme) || '—',
          });
        }
      }

      // Sort by date desc and dedupe by persona_hash+cargo
      const seen = new Set<string>();
      cargosActivos.sort((a, b) => b.fecha_borme.localeCompare(a.fecha_borme));
      for (let i = cargosActivos.length - 1; i >= 0; i--) {
        const key = `${cargosActivos[i].persona_hash}:${cargosActivos[i].cargo}`;
        if (seen.has(key)) {
          cargosActivos.splice(i, 1);
        } else {
          seen.add(key);
        }
      }
    }

    const payload = {
      nif,
      nombre_canonico: nombreCanonico ? titleCase(nombreCanonico) : null,
      verificado,
      borme: bormeInfo,
      cargos_activos: cargosActivos.slice(0, 100),
      actos_recientes: actosRecientes.slice(0, 20),
    };

    CACHE.set(nif, { data: payload, ts: Date.now() });

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err: any) {
    console.error('[borme-info] Error:', err.message);
    return new Response(
      JSON.stringify({ error: 'Error al consultar BORME', detail: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

function inferTipoActo(actos: string): string {
  const a = actos.toLowerCase();
  if (a.includes('nombramiento')) return 'nombramiento';
  if (a.includes('cese') || a.includes('dimisión')) return 'cese';
  if (a.includes('revocación')) return 'revocación';
  if (a.includes('constitución')) return 'constitucion';
  if (a.includes('disolución')) return 'disolucion';
  if (a.includes('liquidación')) return 'liquidacion';
  if (a.includes('concurso')) return 'concurso';
  if (a.includes('modificación') || a.includes('alteración')) return 'modificacion';
  if (a.includes('apertura') || a.includes('sucursal')) return 'apertura';
  if (a.includes('fusión')) return 'fusion';
  if (a.includes('escisión')) return 'escision';
  if (a.includes('domicilio')) return 'domicilio';
  if (a.includes('capital')) return 'capital';
  if (a.includes('objeto')) return 'objeto_social';
  return 'otro';
}
