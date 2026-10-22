/**
 * Cliente IA genérico para endpoints Astro de Elicita.
 * Copia del módulo ia-client.js de ingesta para poder importarlo en el bundle.
 */

const DEFAULT_PRIMARY_MODEL = 'deepseek-v4-flash';
const DEFAULT_FALLBACK_MODEL = 'gemma4:31b';
const DEFAULT_TEMPERATURE = 0.3;
const REQUEST_TIMEOUT_MS = 30_000;

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'https://ollama.com/v1';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';

function log(model: string, msg: string) {
  const line = `[${new Date().toISOString()}] [ia-client:${model}] ${msg}`;
  try {
    console.log(line);
  } catch {
    // console might not be available in every environment
  }
}

export async function callModel(prompt: string, modelOverride?: string, temperature = DEFAULT_TEMPERATURE) {
  const model = modelOverride || DEFAULT_PRIMARY_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OLLAMA_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(model, `error ${res.status}: ${body.slice(0, 200)}`);
      return {
        ok: false,
        content: '',
        model,
        error: `Ollama ${model} error ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    const data = await res.json();
    const content = (data as any)?.choices?.[0]?.message?.content
      || (data as any)?.message?.content
      || (data as any)?.response
      || '';

    return {
      ok: true,
      content: String(content).trim(),
      model,
      error: null,
    };
  } catch (err: any) {
    log(model, `exception: ${err.name}: ${err.message}`);
    return {
      ok: false,
      content: '',
      model,
      error: `Ollama ${model} exception: ${err.name}: ${err.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function callModelWithFallback(
  prompt: string,
  primaryModel?: string,
  fallbackModel?: string,
  temperature = DEFAULT_TEMPERATURE,
) {
  const primary = primaryModel || DEFAULT_PRIMARY_MODEL;
  const fallback = fallbackModel || DEFAULT_FALLBACK_MODEL;

  const first = await callModel(prompt, primary, temperature);
  if (first.ok && first.content) return first;

  const second = await callModel(prompt, fallback, temperature);
  if (second.ok && second.content) {
    return { ...second, fallback: true, primaryError: first.error };
  }

  return {
    ok: false,
    content: '',
    model: `${primary},${fallback}`,
    error: `Primary: ${first.error || 'unknown'}; Fallback: ${second.error || 'unknown'}`,
    primaryError: first.error,
    fallbackError: second.error,
  };
}
