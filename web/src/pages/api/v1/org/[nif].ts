/**
 * GET /api/v1/org/<nif>
 * Returns a company card: adjudicatario name, aggregate contracts,
 * and contract list from contratos_vivos plus BORME data.
 * Auth: Bearer API Key or Clerk session (Pro/Enterprise required).
 */
import type { APIRoute } from 'astro';
import { clerkClient } from '@clerk/astro/server';
import { hashApiKey, isValidApiKeyFormat, getApiKeyByHash, updateLastUsed } from '../../../../lib/api-keys';
import { checkQueryBudget, incrementQueryCount } from '../../../../lib/api-usage';
import { query } from '../../../../lib/duckdb';
import { corregirImporteAdjudicacion, type MotivoCorreccion } from '../../../../lib/correcciones';

async function authenticate(request: Request, locals: any): Promise<{ userId: string; plan: string } | null> {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const key = authHeader.slice(7);
    if (isValidApiKeyFormat(key)) {
      const keyHash = hashApiKey(key);
      const apiKey = await getApiKeyByHash(keyHash);
      if (apiKey && !apiKey.revoked) {
        updateLastUsed(apiKey.id).catch(() => {});
        try {
          const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
          const user = await client.users.getUser(apiKey.userId);
          const metadata = (user.publicMetadata || {}) as Record<string, any>;
          const plan = metadata?.plan || 'free';
          return { userId: apiKey.userId, plan };
        } catch {
          return null;
        }
      }
    }
  }

  const auth = locals?.auth?.();
  if (auth?.userId) {
    try {
      const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
      const user = await client.users.getUser(auth.userId);
      const metadata = (user.publicMetadata || {}) as Record<string, any>;
      const plan = metadata?.plan || 'free';
      return { userId: auth.userId, plan };
    } catch {
      return null;
    }
  }
  return null;
}

function toDateString(v: any): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return s.length >= 10 ? s.slice(0, 10) : s;
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

interface ContratoOrg {
  titulo: string;
  organismo: string;
  importe: number;
  /** Adjudicación corregida según issue #22 upstream; null si no es fiable. */
  importe_corregido?: number | null;
  /** Motivo de la corrección aplicada (registro/escala_x100/…). */
  correccion?: MotivoCorreccion | null;
  fecha: string | null;
  fuente: string;
  cpv: string | null;
  estado: string | null;
  url_pub: string | null;
}

interface BormeOrg {
  domicilio?: string;
  capital_euros?: number;
  fecha_constitucion?: string;
  provincia?: string;
  fecha_borme?: string;
}

export const GET: APIRoute = async ({ params, request, locals }) => {
  const startTime = Date.now();

  try {
    const auth = await authenticate(request, locals);
    if (!auth) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized. Use API Key (Authorization: Bearer ***) or sign in.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (auth.plan !== 'empresa' && auth.plan !== 'pro' && auth.plan !== 'developer') {
      return new Response(
        JSON.stringify({
          error: 'API access requires Enterprise plan',
          upgrade_url: '/cuenta/plan',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const nifRaw = params.nif || '';
    const nif = nifRaw.trim().toUpperCase();
    if (!nif) {
      // Query quota (monthly, API + MCP) — enforcement B0
    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    const user = await client.users.getUser(auth.userId);
    const metadata = (user.publicMetadata || {}) as Record<string, any>;
    const queriesLimit = metadata?.queries_limit || 0;
    const budget = await checkQueryBudget(auth.userId, queriesLimit);
    if (!budget.allowed) {
      return new Response(
        JSON.stringify({ error: 'Query quota exceeded', queries_used: queriesLimit, queries_limit: queriesLimit, upgrade_url: '/precios' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '86400' } },
      );
    }

    return new Response(JSON.stringify({ error: 'NIF requerido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1. Contract summary and list from the unified view.
    // El perfilado consulta la union de la ventana viva (contratos_vivos) con
    // el historico PLACSP completo desde 2012 (calidad mapeado: vista
    // contratos_historico). Dedup por expediente|organismo: gana el estado mas
    // avanzado; a igualdad, el registro historico (tiene el estado final).
    const contratosSql = `
      WITH vivos AS (
        SELECT objeto AS titulo, organismo,
               COALESCE(importe_adjudicacion, importe_licitacion, 0) AS importe,
               importe_adjudicacion AS imp_adj, importe_licitacion AS imp_pres,
               fecha_publicacion AS fecha, fuente, cpv, estado, url AS url_pub,
               CASE WHEN expediente IS NOT NULL AND expediente <> '' AND organismo IS NOT NULL AND organismo <> ''
                    THEN expediente || '|' || organismo ELSE 'id:' || id END AS dedup_key,
               adjudicatario
        FROM contratos_vivos
        WHERE nif_adjudicatario = ?
      ), hist AS (
        SELECT objeto AS titulo, organismo,
               COALESCE(importe_adjudicacion, importe_sin_iva, 0) AS importe,
               importe_adjudicacion AS imp_adj, importe_sin_iva AS imp_pres,
               fecha_publicacion AS fecha, 'PLACSP-hist' AS fuente, cpv, estado, url AS url_pub,
               CASE WHEN expediente IS NOT NULL AND expediente <> '' AND organismo IS NOT NULL AND organismo <> ''
                    THEN expediente || '|' || organismo ELSE 'id:' || id END AS dedup_key,
               adjudicatario
        FROM contratos_historico
        WHERE nif_adjudicatario = ?
      ), uni AS (
        SELECT * FROM vivos UNION ALL SELECT * FROM hist
      ), ranked AS (
        SELECT *, row_number() OVER (
          PARTITION BY dedup_key
          ORDER BY CASE estado WHEN 'Resuelta' THEN 1 WHEN 'Formalizada' THEN 2
                   WHEN 'Adjudicada' THEN 3 WHEN 'En ejecución' THEN 4 ELSE 5 END,
                   CASE WHEN fuente LIKE '%hist' THEN 0 ELSE 1 END,
                   importe DESC NULLS LAST) AS rn
        FROM uni
      )
      SELECT titulo, organismo, importe, fecha, fuente, cpv, estado, url_pub,
             imp_adj, imp_pres, adjudicatario, count(*) OVER () AS total_all
      FROM ranked WHERE rn = 1
      ORDER BY fecha DESC NULLS LAST
      LIMIT 500
    `;
    const contratosRows = await query(contratosSql, [nif, nif]);

    if (!contratosRows || contratosRows.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: 'NIF no encontrado' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Derive canonical name from the most frequent adjudicatario.
    const nameCounts = new Map<string, number>();
    let totalContratos = 0;
    let volumenTotal = 0;
    const contratos: ContratoOrg[] = [];

    let volumenPublicado = 0;
    for (const r of contratosRows) {
      totalContratos++;
      const importe = typeof r.importe === 'number' ? r.importe : 0;
      volumenPublicado += importe;
      // Agregados con el importe corregido (issue #22 upstream): el publicado se
      // enseña tal cual; la suma usa el corregido. Sin adjudicación fiable no suma.
      let importeSuma = importe;
      let importeCorregido: number | null = null;
      let correccion: MotivoCorreccion | null = null;
      if (r.imp_adj != null && Number.isFinite(Number(r.imp_adj))) {
        const corregido = corregirImporteAdjudicacion({
          importeAdjudicacion: Number(r.imp_adj),
          presupuesto: r.imp_pres != null && Number.isFinite(Number(r.imp_pres)) ? Number(r.imp_pres) : null,
          urlPub: r.url_pub,
        });
        importeCorregido = corregido.valor;
        correccion = corregido.motivo;
        importeSuma = corregido.valor ?? 0;
      }
      volumenTotal += importeSuma;

      const adjudicatario = r.adjudicatario;
      if (adjudicatario) {
        const name = String(adjudicatario).trim();
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      }

      contratos.push({
        titulo: r.titulo || 'Sin título',
        organismo: r.organismo || 'Organismo no especificado',
        importe: importe,
        importe_corregido: importeCorregido,
        correccion,
        fecha: toDateString(r.fecha),
        fuente: r.fuente || 'Desconocido',
        cpv: r.cpv || null,
        estado: r.estado || null,
        url_pub: r.url_pub || null,
      });
    }

    const sortedNames = Array.from(nameCounts.entries()).sort((a, b) => b[1] - a[1]);
    const nombre = sortedNames[0]?.[0] || contratosRows[0]?.adjudicatario || nif;

    // 2. Optional BORME enrichment.
    const bormeNorm = normalizeName(nombre);
    const borme: BormeOrg = {};

    try {
      const bormeRows = await query(
        `SELECT empresa, domicilio, capital_euros, fecha_constitucion, provincia, fecha_borme
         FROM borme_empresas
         WHERE empresa_norm LIKE ?
         ORDER BY fecha_borme DESC
         LIMIT 50`,
        [`%${bormeNorm}%`],
      );

      for (const r of bormeRows) {
        if (!borme.domicilio && r.domicilio) borme.domicilio = String(r.domicilio).trim();
        if (borme.capital_euros === undefined && r.capital_euros != null) {
          const n = Number(r.capital_euros);
          if (Number.isFinite(n)) borme.capital_euros = n;
        }
        if (!borme.fecha_constitucion && r.fecha_constitucion) borme.fecha_constitucion = toDateString(r.fecha_constitucion) || undefined;
        if (!borme.provincia && r.provincia) borme.provincia = String(r.provincia).trim();
        if (!borme.fecha_borme && r.fecha_borme) borme.fecha_borme = toDateString(r.fecha_borme) || undefined;
      }
    } catch (bormeErr) {
      // BORME enrichment is optional; don't fail the whole request.
      console.error('[org] BORME enrichment failed:', bormeErr);
    }

    await incrementQueryCount(auth.userId);

    const totalAllTime = Number(contratosRows[0]?.total_all ?? contratosRows.length) || contratosRows.length;

    return new Response(
      JSON.stringify({
        ok: true,
        nif,
        nombre,
        total_contratos: totalContratos,
        total_all_time: totalAllTime,
        volumen_total: Number(volumenTotal.toFixed(2)),
        volumen_total_publicado: Number(volumenPublicado.toFixed(2)),
        contratos,
        borme: Object.keys(borme).length > 0 ? borme : undefined,
        meta: {
          took_ms: Date.now() - startTime,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
