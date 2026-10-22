/**
 * GET /api/ai/resumen?id_contrato=...
 * Devuelve un resumen IA de una licitación, cacheado en ia_resumenes.
 * - Consulta primero el caché; si existe, lo devuelve.
 * - Si no, consulta el contrato en contratos_vivos.
 * - Genera el resumen con Gemma 4 vía Ollama Cloud.
 * - Si falla, fallback a DeepSeek V4 Flash.
 * - Persiste en ia_resumenes y devuelve JSON.
 */
import type { APIRoute } from 'astro';
import { query, queryState } from '../../../lib/duckdb';

// Provider config: NaN Builders is primary, Ollama Cloud is fallback
const NAN_BASE_URL = process.env.NAN_BASE_URL || 'https://api.nan.builders/v1';
const NAN_API_KEY = process.env.NAN_API_KEY || '';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'https://ollama.com/v1';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';

// Model chain: NaN Gemma 4 -> Ollama Gemma 4 -> Ollama DeepSeek V4 Flash
const NAN_PRIMARY_MODEL = process.env.AI_RESUMEN_MODEL_NAN || 'gemma4';
const OLLAMA_FALLBACK_1 = process.env.AI_RESUMEN_MODEL_FALLBACK || 'gemma4:31b';
const OLLAMA_FALLBACK_2 = process.env.AI_RESUMEN_MODEL_PRIMARY || 'deepseek-v4-flash';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESUMEN_CHARS = 150;

interface ResumenIA {
  resumen: string;
  sector: string;
  tipo: string;
  importe_detectado: number | null;
  estado_detectado: string;
}

function isAuthorized(request: Request): boolean {
  const clientIP = request.headers.get('x-real-ip')
    || request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || '';
  const isLocal = !clientIP
    || clientIP.startsWith('127.')
    || clientIP === '::1'
    || clientIP.startsWith('100.');
  return isLocal;
}

function cleanJsonBlock(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  }
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*(?=[}\]])/g, '');
  return s;
}

function parseResumen(raw: string): ResumenIA | null {
  const cleaned = cleanJsonBlock(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') return null;

    const resumen = String(parsed.resumen || parsed.resumen_corto || '').slice(0, MAX_RESUMEN_CHARS);
    const sector = String(parsed.sector || 'otros');
    const tipo = String(parsed.tipo || 'servicio');
    const importeRaw = parsed.importe_estimado ?? parsed.importe_detectado ?? null;
    const importe_detectado = importeRaw === null || importeRaw === undefined || importeRaw === ''
      ? null
      : Number(importeRaw);
    const estado_detectado = String(parsed.plazo_o_estado || parsed.estado_detectado || '');

    if (!resumen) return null;

    return {
      resumen,
      sector,
      tipo,
      importe_detectado: Number.isFinite(importe_detectado) ? importe_detectado : null,
      estado_detectado,
    };
  } catch {
    return null;
  }
}

async function callModel(provider: 'nan' | 'ollama', model: string, prompt: string): Promise<string | null> {
  const baseUrl = provider === 'nan' ? NAN_BASE_URL : OLLAMA_BASE_URL;
  const apiKey = provider === 'nan' ? NAN_API_KEY : OLLAMA_API_KEY;
  const url = `${baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[ai/resumen] ${provider} ${model} error ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content
      || data?.message?.content
      || data?.response
      || '';
    return String(content).trim();
  } catch (err: any) {
    console.error(`[ai/resumen] ${provider} ${model} exception: ${err.name}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateResumen(objeto: string, organismo: string, importe: number | null, estado: string): Promise<ResumenIA | null> {
  const prompt = `Eres un asistente que resume licitaciones públicas. Dado el siguiente contrato, extrae:
1. resumen: una frase clara de qué se pide (máx 150 caracteres)
2. sector: sector al que pertenece (ej: software, construcción, sanidad, consultoría, transporte, hostelería, etc.)
3. importe_estimado: el importe si se menciona, o null
4. plazo_o_estado: estado o plazo si se menciona
5. tipo: tipo de contrato (suministro, servicio, obra, concesión)

Responde SOLO en JSON válido.

Contrato:
- Objeto: ${objeto}
- Organismo: ${organismo}
- Importe: ${importe ?? 'No especificado'}
- Estado: ${estado}`;

  // Model chain: NaN Gemma 4 -> Ollama Gemma 4 -> Ollama DeepSeek V4 Flash
  const chain: Array<{provider: 'nan' | 'ollama', model: string}> = [
    { provider: 'nan', model: NAN_PRIMARY_MODEL },
    { provider: 'ollama', model: OLLAMA_FALLBACK_1 },
    { provider: 'ollama', model: OLLAMA_FALLBACK_2 },
  ];

  for (const { provider, model } of chain) {
    const raw = await callModel(provider, model, prompt);
    const parsed = raw ? parseResumen(raw) : null;
    if (parsed) {
      (parsed as any).modelo = `${provider}/${model}`;
      return parsed as ResumenIA & { modelo: string };
    }
  }

  return null;
}

async function getCachedResumen(id_contrato: string): Promise<any | null> {
  try {
    const rows = await queryState(
      `SELECT id_contrato, modelo, resumen, sector, tipo, importe_detectado, estado_detectado, fecha_generacion
       FROM ia_resumenes WHERE id_contrato = ? LIMIT 1`,
      [id_contrato]
    );
    if (rows.length) return rows[0];
  } catch (err: any) {
    console.error('[ai/resumen] cache query error:', err.message);
  }
  return null;
}

async function saveResumen(
  id_contrato: string,
  modelo: string,
  resumen: ResumenIA
): Promise<void> {
  const sql = `INSERT INTO ia_resumenes
    (id_contrato, modelo, resumen, sector, tipo, importe_detectado, estado_detectado, fecha_generacion)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
  await queryState(sql, [id_contrato, modelo, resumen.resumen, resumen.sector, resumen.tipo, resumen.importe_detectado, resumen.estado_detectado]);
}

export const GET: APIRoute = async ({ url, request }) => {
  try {
    // Optional auth: restrict to local / Tailscale by default; allow override via env.
    const requireLocal = process.env.AI_RESUMEN_REQUIRE_LOCAL !== 'false';
    if (requireLocal && !isAuthorized(request)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const id_contrato = url.searchParams.get('id_contrato')?.trim();
    if (!id_contrato) {
      return new Response(JSON.stringify({ error: 'Falta id_contrato' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1. Cache hit
    const cached = await getCachedResumen(id_contrato);
    if (cached) {
      return new Response(JSON.stringify({ ok: true, cached: true, ...cached }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Fetch contract from DuckDB
    const contractRows = await query(
      `SELECT objeto, organismo, importe_licitacion, estado
       FROM contratos_vivos WHERE id = ? LIMIT 1`,
      [id_contrato]
    );

    if (!contractRows.length) {
      return new Response(JSON.stringify({ error: 'Contrato no encontrado' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { objeto, organismo, importe_licitacion, estado } = contractRows[0];

    // 3. Generate
    const generated = await generateResumen(
      String(objeto || ''),
      String(organismo || ''),
      importe_licitacion ? Number(importe_licitacion) : null,
      String(estado || '')
    );

    if (!generated) {
      return new Response(JSON.stringify({ error: 'No se pudo generar el resumen. Ambos modelos fallaron.' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const modelo = (generated as any).modelo || PRIMARY_MODEL;

    // 4. Persist
    await saveResumen(id_contrato, modelo, generated);

    return new Response(JSON.stringify({
      ok: true,
      cached: false,
      id_contrato,
      modelo,
      resumen: generated.resumen,
      sector: generated.sector,
      tipo: generated.tipo,
      importe_detectado: generated.importe_detectado,
      estado_detectado: generated.estado_detectado,
      fecha_generacion: new Date().toISOString(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[ai/resumen] Endpoint error:', err.message);
    return new Response(JSON.stringify({ error: 'Error generando resumen', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
