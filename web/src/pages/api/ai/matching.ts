/**
 * POST /api/ai/matching
 * Recibe { user_id, limite? } y devuelve contratos matcheados para el perfil IA.
 * 1. Lee perfil de ia_perfiles
 * 2. Pre-filtra contratos por CPV, fuente, organismo, importe, fecha reciente
 * 3. Llama a Gemma 4 para scoring (fallback DeepSeek)
 * 4. Guarda en ia_matching_results y devuelve resultados
 */
import type { APIRoute } from 'astro';
import { query, queryState } from '../../../lib/duckdb';
import { clerkClient } from '@clerk/astro/server';
import { ADMIN_IDS, ADMIN_USERNAMES } from '../../../lib/plan';
import { callModelWithFallback } from '../../../lib/ia-client';

const PRIMARY_MODEL = process.env.AI_MATCHING_MODEL_PRIMARY || 'gemma4:31b';
const FALLBACK_MODEL = process.env.AI_MATCHING_MODEL_FALLBACK || 'deepseek-v4-flash';
const MAX_CANDIDATES = 50;
const DEFAULT_LIMIT = 50;

function isAdmin(user: any): boolean {
  if (!user) return false;
  return ADMIN_USERNAMES.includes(user.username || '') || ADMIN_IDS.includes(user.id);
}

async function getClerkUser(locals: any) {
  try {
    const auth = (locals as any)?.auth?.();
    const userId = auth?.userId;
    if (!userId) return null;
    const client = clerkClient({ secretKey: import.meta.env.CLERK_SECRET_KEY });
    return await client.users.getUser(userId);
  } catch {
    return null;
  }
}

function getCpvPrefixes(cpvs: string[]): string[] {
  return cpvs
    .map((c) => String(c).replace('.0', '').trim().replace(/\s+/g, '').slice(0, 5))
    .filter((c) => /^\d{5}$/.test(c));
}

function sanitizeTextArray(arr: any): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => String(x || '').trim())
    .filter((x) => x.length > 0);
}

async function findContratosPorPerfil(perfil: any, limite: number) {
  const conditions: string[] = [];
  const params: any[] = [];

  // Fecha reciente: últimos 7 días si no hay perfil, o filtrar por fecha
  conditions.push('fecha_publicacion >= ?');
  params.push(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));

  // CPV
  const cpvs = getCpvPrefixes(sanitizeTextArray(perfil.cpvs));
  if (cpvs.length > 0) {
    const placeholders = cpvs.map(() => '?').join(',');
    conditions.push(`SUBSTRING(REPLACE(REPLACE(cpv, '.0', ''), ' ', ''), 1, 5) IN (${placeholders})`);
    params.push(...cpvs);
  }

  // Fuentes
  const fuentes = sanitizeTextArray(perfil.fuentes).map((f) => f.toUpperCase());
  if (fuentes.length > 0) {
    conditions.push(`UPPER(fuente) IN (${fuentes.map(() => '?').join(',')})`);
    params.push(...fuentes);
  }

  // Organismos
  const organismos = sanitizeTextArray(perfil.organismos);
  if (organismos.length > 0) {
    const orgLikes = organismos.map(() => 'LOWER(organismo) LIKE ?');
    conditions.push(`(${orgLikes.join(' OR ')})`);
    params.push(...organismos.map((o) => `%${o.toLowerCase()}%`));
  }

  // Importe
  if (perfil.importe_min != null && Number.isFinite(Number(perfil.importe_min)) && Number(perfil.importe_min) > 0) {
    conditions.push('importe_licitacion >= ?');
    params.push(Number(perfil.importe_min));
  }
  if (perfil.importe_max != null && Number.isFinite(Number(perfil.importe_max)) && Number(perfil.importe_max) > 0) {
    conditions.push('importe_licitacion <= ?');
    params.push(Number(perfil.importe_max));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT
      id,
      fuente,
      organismo,
      objeto,
      cpv,
      importe_licitacion,
      fecha_publicacion
    FROM contratos_vivos
    ${where}
    ORDER BY fecha_publicacion DESC, id DESC
    LIMIT ?
  `;

  return await query(sql, [...params, Math.min(limite, MAX_CANDIDATES)]);
}

function buildPrompt(perfil: any, contratos: any[]): string {
  const cpvs = (perfil.cpvs || []).join(', ') || 'ninguno';
  const organismos = (perfil.organismos || []).join(', ') || 'ninguno';
  const sectores = (perfil.sectores || []).join(', ') || 'ninguno';
  const importeMin = perfil.importe_min != null ? `€${perfil.importe_min.toLocaleString('es-ES')}` : 'sin límite';
  const importeMax = perfil.importe_max != null ? `€${perfil.importe_max.toLocaleString('es-ES')}` : 'sin límite';

  const lista = contratos
    .map((c, i) => {
      const objeto = String(c.objeto || '').slice(0, 200).replace(/\n/g, ' ');
      const importe = c.importe_licitacion != null ? Number(c.importe_licitacion) : null;
      const importeStr = importe != null && Number.isFinite(importe) ? `€${importe.toLocaleString('es-ES')}` : 'no especificado';
      return `${i + 1}. ID: ${c.id}\n   Objeto: ${objeto}\n   Organismo: ${c.organismo || '—'}\n   CPV: ${c.cpv || '—'}\n   Importe: ${importeStr}\n   Fuente: ${c.fuente || '—'}`;
    })
    .join('\n\n');

  return `Eres un asistente que evalúa la relevancia de licitaciones públicas para el perfil de un usuario.

Perfil del usuario:
- CPVs de interés: ${cpvs}
- Organismos de interés: ${organismos}
- Sectores de interés: ${sectores}
- Importe mínimo: ${importeMin}
- Importe máximo: ${importeMax}

Contratos candidatos:
${lista}

Para cada contrato, devuelve un JSON array con:
- id_contrato: el id del contrato
- score: relevancia de 0 a 100 (0 = irrelevante, 100 = match perfecto)
- motivo: una frase explicando por qué es relevante (o por qué no)

El score debe reflejar: coincidencia de CPV, coincidencia de organismo, rango de importe, relevancia semántica del objeto con los sectores del usuario.

Devuelve SOLO el JSON array, sin markdown ni explicaciones.`;
}

function cleanJsonBlock(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  }
  s = s.replace(/,\s*(?=[}\]])/g, '');
  return s;
}

function parseMatches(raw: string, contratos: any[]): Array<{ id_contrato: string; score: number; motivo: string }> {
  const cleaned = cleanJsonBlock(raw);
  let parsed: any[] = [];
  try {
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    // intentar extraer array con regex
    const match = cleaned.match(/\[([\s\S]*)\]/);
    if (match) {
      try {
        parsed = JSON.parse(`[${match[1]}]`);
        if (!Array.isArray(parsed)) parsed = [];
      } catch {
        parsed = [];
      }
    }
  }

  const validIds = new Set(contratos.map((c) => c.id));
  return parsed
    .filter((item: any) => item && validIds.has(item.id_contrato))
    .map((item: any) => ({
      id_contrato: item.id_contrato,
      score: Math.max(0, Math.min(100, Number(item.score) || 0)),
      motivo: String(item.motivo || '').slice(0, 300),
    }));
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = await getClerkUser(locals);
    const currentUserId = (user as any)?.id;

    if (!currentUserId) {
      return new Response(JSON.stringify({ error: 'No autenticado' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Body JSON inválido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const targetUserId = (body.user_id || currentUserId).trim();
    if (targetUserId !== currentUserId && !isAdmin(user)) {
      return new Response(JSON.stringify({ error: 'No puedes ejecutar matching para otros usuarios' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const limite = Math.min(Number(body.limite) || DEFAULT_LIMIT, MAX_CANDIDATES);

    // Leer perfil
    const perfilRows = await queryState(
      `SELECT user_id, email, nombre, cpvs, organismos, fuentes, importe_min, importe_max, sectores, activo
       FROM ia_perfiles WHERE user_id = ? LIMIT 1`,
      [targetUserId]
    );

    let perfil = perfilRows[0] || null;
    if (!perfil) {
      // Sin perfil: usar defaults (últimos 7 días)
      perfil = { cpvs: [], organismos: [], fuentes: [], sectores: [], importe_min: null, importe_max: null };
    } else if (!perfil.activo) {
      return new Response(
        JSON.stringify({ ok: true, resultados: [], count: 0, skipped: 'perfil_inactivo' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const contratos = await findContratosPorPerfil(perfil, limite);
    if (contratos.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, resultados: [], count: 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const prompt = buildPrompt(perfil, contratos);
    const iaRes = await callModelWithFallback(prompt, PRIMARY_MODEL, FALLBACK_MODEL, 0.2);

    if (!iaRes.ok || !iaRes.content) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'No se pudo generar el matching. Ambos modelos fallaron.',
          detail: iaRes.error,
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const matches = parseMatches(iaRes.content, contratos);

    // Guardar resultados (upsert) — en web-state (conexión corta por operación)
    const now = new Date().toISOString();
    let guardados = 0;
    for (const m of matches) {
      try {
        await queryState(
          `INSERT INTO ia_matching_results (id_contrato, user_id, score, motivo, fecha_match, enviado_email, fecha_envio)
           VALUES (?, ?, ?, ?, ?, false, NULL)
           ON CONFLICT (id_contrato, user_id) DO UPDATE SET
             score = EXCLUDED.score,
             motivo = EXCLUDED.motivo,
             fecha_match = EXCLUDED.fecha_match,
             enviado_email = false,
             fecha_envio = NULL`,
          [m.id_contrato, targetUserId, m.score, m.motivo, now]
        );
        guardados++;
      } catch (err: any) {
        console.error(`[ai/matching] Error guardando match ${m.id_contrato}:`, err.message);
      }
    }

    // Enriquecer resultados con datos de contrato
    const resultados = matches.map((m) => {
      const c = contratos.find((x) => x.id === m.id_contrato);
      return {
        id_contrato: m.id_contrato,
        score: m.score,
        motivo: m.motivo,
        objeto: c?.objeto || null,
        organismo: c?.organismo || null,
        importe_licitacion: c?.importe_licitacion || null,
        fecha_publicacion: c?.fecha_publicacion || null,
      };
    });

    return new Response(
      JSON.stringify({
        ok: true,
        resultados,
        count: resultados.length,
        model: iaRes.model,
        fallback: iaRes.fallback || false,
        guardados,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('[ai/matching] Endpoint error:', err.message);
    return new Response(
      JSON.stringify({ ok: false, error: 'Error en matching', detail: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
