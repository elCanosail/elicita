import type { APIRoute } from 'astro';
import { query } from '../../lib/duckdb';
import { requireAuth } from '../../lib/api-auth';

function toNum(v: any): number {
  if (typeof v === 'bigint') return Number(v);
  return Number(v) || 0;
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

interface CachedConflictos {
  data: {
    empresa: string;
    nif: string;
    conflictos: Conflicto[];
    total_conflictos: number;
    parcial?: boolean;
  };
  ts: number;
}

interface Conflicto {
  persona_hash: string;
  cargo_origen: string;
  empresa_vinculada: string;
  nif_vinculada: string | null;
  cargo_vinculada: string;
  organismo_comun: string;
  contratos_origen: number;
  volumen_origen: number;
  contratos_vinculada: number;
  volumen_vinculada: number;
}

const CACHE = new Map<string, CachedConflictos>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const CACHE_MAX_ENTRIES = 200; // Evitar crecimiento ilimitado

/** Evict oldest entries when cache exceeds max size. */
function evictOldCacheEntries(): void {
  if (CACHE.size <= CACHE_MAX_ENTRIES) return;
  // Sort by timestamp, delete oldest 20%
  const entries = [...CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const toRemove = Math.floor(entries.length * 0.2);
  for (let i = 0; i < toRemove; i++) {
    CACHE.delete(entries[i][0]);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

export const GET: APIRoute = async ({ url, locals }) => {
  const { error } = requireAuth(locals);
  if (error) return error;
  const nif = url.searchParams.get('nif')?.trim() || '';
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

  let parcial = false;
  const conflictos: Conflicto[] = [];

  try {
    // 0. Resolve company name from contracts
    const empresaName = await withTimeout(
      query(
        `SELECT DISTINCT adjudicatario
         FROM contratos_vivos
         WHERE nif_adjudicatario = ? AND adjudicatario IS NOT NULL
         LIMIT 1`,
        [nif]
      ),
      5000
    );
    const companyName = titleCase(empresaName[0]?.adjudicatario || '');
    if (!companyName) {
      const payload = {
        empresa: companyName || nif,
        nif,
        conflictos: [],
        total_conflictos: 0,
      };
      evictOldCacheEntries();
    CACHE.set(nif, { data: payload, ts: Date.now() });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const bormeNorm = normalizeName(companyName);

    // 1. Active persons in this company
    let personasCargos: { persona_hash: string; cargo: string }[] = [];
    try {
      const rows = await withTimeout(
        query(
          `SELECT persona_hash, cargo
           FROM borme_cargos
           WHERE empresa_norm LIKE ?
             AND tipo_acto IN ('nombramiento', 'reelección', 'renovación')
           ORDER BY fecha_borme DESC
           LIMIT 500`,
          [`%${bormeNorm}%`]
        ),
        10000
      );

      // Keep only the latest cargo per person
      const latestByHash = new Map<string, string>();
      for (const r of rows) {
        if (!r.persona_hash) continue;
        if (!latestByHash.has(r.persona_hash)) {
          latestByHash.set(r.persona_hash, r.cargo || '');
        }
      }
      personasCargos = Array.from(latestByHash.entries()).map(([persona_hash, cargo]) => ({
        persona_hash,
        cargo,
      }));
    } catch (e: any) {
      console.error('[conflictos] paso 1 error:', e.message);
      parcial = true;
    }

    if (personasCargos.length === 0) {
      const payload = {
        empresa: companyName,
        nif,
        conflictos: [],
        total_conflictos: 0,
        parcial,
      };
      evictOldCacheEntries();
    CACHE.set(nif, { data: payload, ts: Date.now() });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Other companies where those persons have active positions
    const personHashes = personasCargos.map((p) => p.persona_hash);
    let linkedCompanies: { empresa: string; empresa_norm: string; persona_hash: string; cargo: string }[] = [];
    try {
      const hashPlaceholders = personHashes.map(() => '?').join(',');
      const rows = await withTimeout(
        query(
          `SELECT DISTINCT empresa, empresa_norm, persona_hash, cargo
           FROM borme_cargos
           WHERE persona_hash IN (${hashPlaceholders})
             AND empresa_norm NOT LIKE ?`,
          [...personHashes, `%${bormeNorm}%`]
        ),
        10000
      );
      // Keep the latest role per (persona, empresa)
      const latest = new Map<string, { empresa: string; empresa_norm: string; persona_hash: string; cargo: string }>();
      for (const r of rows) {
        const key = `${r.persona_hash}::${r.empresa_norm}`;
        if (!latest.has(key)) {
          latest.set(key, {
            empresa: r.empresa,
            empresa_norm: r.empresa_norm,
            persona_hash: r.persona_hash,
            cargo: r.cargo || '',
          });
        }
      }
      linkedCompanies = Array.from(latest.values()).slice(0, 100);
    } catch (e: any) {
      console.error('[conflictos] paso 2 error:', e.message);
      parcial = true;
    }

    if (linkedCompanies.length === 0) {
      const payload = {
        empresa: companyName,
        nif,
        conflictos: [],
        total_conflictos: 0,
        parcial,
      };
      evictOldCacheEntries();
    CACHE.set(nif, { data: payload, ts: Date.now() });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Contracts for the original company by organismo (used to compute common organismos)
    const orgRows = await withTimeout(
      query(
        `SELECT organismo, COUNT(*) AS contratos, COALESCE(SUM(importe_adjudicacion), 0) AS volumen
         FROM contratos_vivos
         WHERE nif_adjudicatario = ? AND organismo IS NOT NULL
         GROUP BY organismo`,
        [nif]
      ),
      10000
    );
    const organismosOrigen = new Map<string, { contratos: number; volumen: number }>();
    for (const r of orgRows) {
      organismosOrigen.set(r.organismo, { contratos: toNum(r.contratos), volumen: toNum(r.volumen) });
    }

    // 4. For each linked company, find contracts with common organismos
    const seenKeys = new Set<string>();
    for (const linked of linkedCompanies) {
      try {
        // Find any contract where the linked company appears as adjudicatario and organismo is in common
        const rows = await withTimeout(
          query(
            `SELECT organismo, COUNT(*) AS contratos, COALESCE(SUM(importe_adjudicacion), 0) AS volumen,
                    MAX(nif_adjudicatario) AS nif_vinculada
             FROM contratos_vivos
             WHERE adjudicatario ILIKE ?
               AND organismo IS NOT NULL
             GROUP BY organismo
             ORDER BY volumen DESC
             LIMIT 50`,
            [`%${linked.empresa}%`]
          ),
          8000
        );

        for (const r of rows) {
          const org = r.organismo;
          const origen = organismosOrigen.get(org);
          if (!origen) continue;

          const key = `${linked.persona_hash}::${linked.empresa_norm}::${org}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          const origenCargo = personasCargos.find((p) => p.persona_hash === linked.persona_hash)?.cargo || '';

          conflictos.push({
            persona_hash: linked.persona_hash,
            cargo_origen: origenCargo,
            empresa_vinculada: linked.empresa,
            nif_vinculada: r.nif_vinculada || null,
            cargo_vinculada: linked.cargo,
            organismo_comun: org,
            contratos_origen: origen.contratos,
            volumen_origen: origen.volumen,
            contratos_vinculada: toNum(r.contratos),
            volumen_vinculada: toNum(r.volumen),
          });
        }
      } catch (e: any) {
        console.error('[conflictos] linked company error:', linked.empresa, e.message);
        parcial = true;
      }
    }

    const payload = {
      empresa: companyName,
      nif,
      conflictos,
      total_conflictos: conflictos.length,
      parcial,
    };
    evictOldCacheEntries();
    CACHE.set(nif, { data: payload, ts: Date.now() });

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err: any) {
    console.error('[conflictos] Error:', err.message);
    return new Response(
      JSON.stringify({ error: 'Error al analizar cargos compartidos', detail: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

function titleCase(s: string): string {
  if (!s) return s;
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(S\.L\.|S\.A\.|S\.L\.U\.|S\.A\.U\.|S\.C\.)(?=$|\s)/gi, (m) => m.toUpperCase());
}
