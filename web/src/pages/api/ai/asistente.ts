/**
 * GET /api/ai/asistente?query=...
 * Traduce una pregunta en lenguaje natural a SQL SELECT sobre contratos_vivos,
 * valida y ejecuta la consulta, y devuelve los resultados.
 */
import type { APIRoute } from 'astro';
import { query } from '../../../lib/duckdb';

// Provider config: NaN Builders is primary, Ollama Cloud is fallback
const NAN_BASE_URL = process.env.NAN_BASE_URL || 'https://api.nan.builders/v1';
const NAN_API_KEY = process.env.NAN_API_KEY || '';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'https://ollama.com/v1';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';

// Model chain: NaN Gemma 4 -> Ollama Gemma 4 -> Ollama DeepSeek V4 Flash
const NAN_PRIMARY_MODEL = process.env.AI_ASISTENTE_MODEL_NAN || 'gemma4';
const OLLAMA_FALLBACK_1 = process.env.AI_ASISTENTE_MODEL_FALLBACK || 'gemma4:31b';
const OLLAMA_FALLBACK_2 = process.env.AI_ASISTENTE_MODEL_PRIMARY || 'deepseek-v4-flash';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 100;

const FORBIDDEN_KEYWORDS = [
  'drop', 'delete', 'update', 'insert', 'alter', 'create', 'truncate',
];

interface CallModelResult {
  ok: boolean;
  content: string;
  model: string;
  error?: string;
  fallback?: boolean;
  primaryError?: string;
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

function buildSystemPrompt(query: string): string {
  return `Eres un asistente que traduce preguntas en lenguaje natural a consultas SQL sobre una base de datos de contratación pública española.

Esquema de la tabla \`contratos_vivos\`:
- id (TEXT)
- fuente (TEXT) — valores: PLACSP, ANDALUCIA, MADRID, VALENCIA, EUSKADI, GALICIA, ASTURIAS, CATALUNYA, ARAGON, TED
- expediente (TEXT)
- organismo (TEXT)
- objeto (TEXT) — descripción del contrato
- cpv (TEXT) — código CPV principal
- cpvs (TEXT[]) — array de códigos CPV
- importe_licitacion (DOUBLE)
- importe_adjudicacion (DOUBLE)
- fecha_publicacion (DATE)
- fecha_fin (DATE)
- url (TEXT)
- estado (TEXT) — valores: abierto, adjudicado, cerrado, evaluacion, etc.
- adjudicatario (TEXT)
- nif_adjudicatario (TEXT)

Notas importantes:
- NO existe columna provincia, comunidad_autonoma, cpv_descripcion ni tipo_contrato
- Para filtrar por comunidad autónoma, usa la columna fuente (ej: fuente = 'MADRID' para Madrid, fuente = 'ANDALUCIA' para Andalucía)
- Para filtrar por importe, usa importe_licitacion
- Para buscar texto, usa LIKE '%texto%' en objeto u organismo

Reglas:
- Genera SOLO la consulta SQL SELECT (sin explicaciones, sin markdown)
- Usa LIKE con % para búsquedas parciales de texto en objeto y organismo
- Usa fecha_publicacion >= 'YYYY-MM-DD' para filtros de fecha
- Usa LIMIT 50 por defecto
- NO uses CREATE, INSERT, UPDATE, DELETE, DROP, ALTER
- Ordena por fecha_publicacion DESC por defecto
- Para importes, usa importe_licitacion

Pregunta del usuario: ${query}`;
}

async function callModel(provider: 'nan' | 'ollama', model: string, prompt: string): Promise<CallModelResult> {
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
        temperature: 0.1,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[ai/asistente] ${provider} ${model} error ${res.status}: ${body.slice(0, 200)}`);
      return {
        ok: false,
        content: '',
        model: `${provider}/${model}`,
        error: `${provider} ${model} error ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content
      || data?.message?.content
      || data?.response
      || '';

    return {
      ok: true,
      content: String(content).trim(),
      model: `${provider}/${model}`,
    };
  } catch (err: any) {
    console.error(`[ai/asistente] ${provider} ${model} exception: ${err.name}: ${err.message}`);
    return {
      ok: false,
      content: '',
      model: `${provider}/${model}`,
      error: `${provider} ${model} exception: ${err.name}: ${err.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSql(query: string): Promise<CallModelResult & { sql?: string }> {
  const prompt = buildSystemPrompt(query);

  // Model chain: NaN Gemma 4 -> Ollama DeepSeek V4 Flash -> Ollama Gemma 4
  const chain: Array<{provider: 'nan' | 'ollama', model: string}> = [
    { provider: 'nan', model: NAN_PRIMARY_MODEL },
    { provider: 'ollama', model: OLLAMA_FALLBACK_1 },
    { provider: 'ollama', model: OLLAMA_FALLBACK_2 },
  ];

  let lastError: string | undefined;
  for (let i = 0; i < chain.length; i++) {
    const { provider, model } = chain[i];
    const result = await callModel(provider, model, prompt);
    if (result.ok && result.content) {
      return { ...result, sql: extractSql(result.content), fallback: i > 0, primaryError: i === 0 ? undefined : lastError };
    }
    lastError = result.error;
  }

  return {
    ok: false,
    content: '',
    model: chain.map(c => `${c.provider}/${c.model}`).join(','),
    error: `All models failed. Last: ${lastError || 'unknown'}`,
    primaryError: lastError,
    fallback: false,
  };
}

function extractSql(raw: string): string {
  let s = raw.trim();
  // Strip markdown code fences
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  // Normalize whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function isSafeSql(sql: string): { safe: boolean; reason?: string } {
  if (!sql) return { safe: false, reason: 'SQL vacío' };

  const normalized = sql.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (!lower.startsWith('select')) {
    return { safe: false, reason: 'La consulta debe empezar con SELECT' };
  }

  for (const kw of FORBIDDEN_KEYWORDS) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    if (regex.test(normalized)) {
      return { safe: false, reason: `Palabra clave prohibida detectada: ${kw.toUpperCase()}` };
    }
  }

  return { safe: true };
}

function enforceLimit(sql: string): string {
  // Remove trailing semicolon, LIMIT clauses (with or without offset) and re-add a capped one.
  let cleaned = sql.replace(/\s*;\s*$/, '').trim();
  cleaned = cleaned.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '').trim();
  cleaned = cleaned.replace(/\s+OFFSET\s+\d+\s*$/i, '').trim();
  return `${cleaned} LIMIT ${MAX_RESULTS}`;
}

export const GET: APIRoute = async ({ url, request }) => {
  try {
    // Optional auth: restrict to local / Tailscale by default; allow override via env.
    const requireLocal = process.env.AI_ASISTENTE_REQUIRE_LOCAL !== 'false';
    if (requireLocal && !isAuthorized(request)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const queryText = url.searchParams.get('query')?.trim();
    if (!queryText) {
      return new Response(JSON.stringify({ error: 'Falta el parámetro query' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1. Generate SQL
    const generated = await generateSql(queryText);
    if (!generated.ok || !generated.sql) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'No se pudo generar la consulta. Ambos modelos fallaron.',
        detail: generated.error,
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Validate SQL
    const safety = isSafeSql(generated.sql);
    if (!safety.safe) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Consulta no segura',
        detail: safety.reason,
        sql: generated.sql,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Enforce LIMIT
    const safeSql = enforceLimit(generated.sql);

    // 4. Execute
    const startTime = Date.now();
    const rows = await query(safeSql);
    const tookMs = Date.now() - startTime;

    return new Response(JSON.stringify({
      ok: true,
      sql: safeSql,
      results: rows,
      count: rows.length,
      model: generated.model,
      fallback: generated.fallback || false,
      took_ms: tookMs,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('[ai/asistente] Endpoint error:', err.message);
    return new Response(JSON.stringify({
      ok: false,
      error: 'Error ejecutando la consulta',
      detail: err.message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
