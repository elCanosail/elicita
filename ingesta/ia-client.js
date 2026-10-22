/**
 * Cliente IA genérico para Elicita.
 * Funciona en endpoints Astro (import) y scripts del scheduler (require).
 * Envuelve llamadas a un proveedor OpenAI-compatible (NaN Builders) con timeout y fallback.
 */

const DEFAULT_PRIMARY_MODEL = 'deepseek-v4-flash';
const DEFAULT_FALLBACK_MODEL = 'gemma4';
const DEFAULT_TEMPERATURE = 0.3;
const REQUEST_TIMEOUT_MS = 30_000;

// Proveedor IA: NaN Builders (OpenAI-compatible). Key en /root/.nan_api_key,
// fuera de git y del env de PM2. Solo IA_*/NAN_API_KEY como overrides; los
// OLLAMA_* legacy se ignoran deliberadamente.
const IA_BASE_URL = (() => {
  try {
    return process.env.IA_BASE_URL || 'https://api.nan.builders/v1';
  } catch {
    return 'https://api.nan.builders/v1';
  }
})();

const IA_API_KEY = (() => {
  try {
    if (process.env.NAN_API_KEY || process.env.IA_API_KEY) {
      return process.env.NAN_API_KEY || process.env.IA_API_KEY;
    }
    return require('fs').readFileSync('/root/.nan_api_key', 'utf8').trim();
  } catch {
    return '';
  }
})();

function log(model, msg) {
  const line = `[${new Date().toISOString()}] [ia-client:${model}] ${msg}`;
  try {
    console.log(line);
  } catch {
    // console might not be available in every environment
  }
}

async function callModel(prompt, modelOverride, temperature = DEFAULT_TEMPERATURE) {
  const model = modelOverride || DEFAULT_PRIMARY_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${IA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${IA_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: model.startsWith('gemma') ? 0.6 : temperature,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(model, `IA error ${res.status}: ${body.slice(0, 200)}`);
      return {
        ok: false,
        content: '',
        model,
        error: `IA ${model} error ${res.status}: ${body.slice(0, 200)}`,
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
      model,
      error: null,
    };
  } catch (err) {
    log(model, `IA exception: ${err.name}: ${err.message}`);
    return {
      ok: false,
      content: '',
      model,
      error: `IA ${model} exception: ${err.name}: ${err.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callModelWithFallback(prompt, primaryModel, fallbackModel, temperature = DEFAULT_TEMPERATURE) {
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

module.exports = {
  callModel,
  callModelWithFallback,
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_FALLBACK_MODEL,
};
