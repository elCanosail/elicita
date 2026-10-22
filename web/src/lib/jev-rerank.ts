/**
 * JEV (TypeSafe System One) semantic re-ranking for the search endpoints.
 *
 * Design rules from the spike (docs/plans/track-jev-buscador-spike.md):
 * - JEV orders WITHIN a candidate pool (relative re-ranking); it is never an
 *   absolute gate — scores are only used to sort, never to drop rows.
 * - Fails open: any error (missing key, HTTP error, timeout, bad payload)
 *   returns null and the caller keeps the classic tokenized order.
 * - Double gate: the caller must pass `smart=1` AND the server must have
 *   ELICITA_JEV_SMART=1 plus an API key configured.
 */
import fs from 'fs';

const SYSTEMONE_URL =
  process.env.ELICITA_TYPESAFE_URL || 'https://api.typesafe.ai/v1/systemone';
const RERANK_TIMEOUT_MS = 10_000;
const MAX_CANDIDATES = 25;

/**
 * API key: variable de entorno con prioridad; si no, fichero protegido
 * (/root/.typesafe_api_key por defecto, reubicable con ELICITA_TYPESAFE_KEY_FILE).
 * La clave nunca viaja en la config de PM2 ni en el repo.
 */
function apiKey(): string | null {
  const env = process.env.ELICITA_TYPESAFE_API_KEY;
  if (env) return env;
  try {
    const file =
      process.env.ELICITA_TYPESAFE_KEY_FILE || '/root/.typesafe_api_key';
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export interface RerankCandidate {
  id: string;
  titulo?: string | null;
}

export interface RerankResult {
  scores: Record<string, number>;
  ms: number;
}

/**
 * Server-side switch for smart search. Both the env flag and an API key must
 * be present; the per-request `smart=1` parameter is checked by the caller.
 */
export function jevRerankEnabled(): boolean {
  return process.env.ELICITA_JEV_SMART === '1' && Boolean(apiKey());
}

/**
 * Ask JEV, once per query, whether each candidate clearly matches what the
 * user is looking for. Returns null (fail-open) on any problem.
 */
export async function jevRerank(
  consulta: string,
  candidates: RerankCandidate[]
): Promise<RerankResult | null> {
  const key = apiKey();
  if (!key || candidates.length < 2) return null;

  const pool = candidates.slice(0, MAX_CANDIDATES);
  const questions: Record<string, unknown> = {};
  for (const c of pool) {
    questions[c.id] = {
      type: 'noul',
      instructions: `Expediente de licitación pública. Título/objeto: ${String(
        c.titulo || ''
      ).slice(0, 300)}. — ¿Corresponde a lo que el usuario busca?`,
      criteria: {
        true: 'Corresponde claramente a la necesidad del usuario',
        false: 'No corresponde a lo buscado',
      },
    };
  }

  const t0 = Date.now();
  try {
    const res = await fetch(SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'jev-latest',
        state: `Usuario buscando licitaciones públicas. Consulta: "${consulta}"`,
        questions,
      }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const scores: Record<string, number> = {};
    for (const [k, v] of Object.entries(json?.answers || {})) {
      const n = Number((v as any)?.noul);
      scores[k] = Number.isFinite(n) ? n : 0;
    }
    return { scores, ms: Date.now() - t0 };
  } catch {
    return null;
  }
}

/**
 * Pure reordering: JEV score desc, stable tiebreak by original order.
 * Candidates missing from the score map count as 0 (sink to the bottom
 * alongside unrated ones, without changing their relative order).
 */
export function applyRerank<T extends RerankCandidate>(
  candidates: T[],
  scores: Record<string, number>
): T[] {
  return candidates
    .map((c, idx) => ({ c, idx, s: scores[c.id] ?? 0 }))
    .sort((a, b) => b.s - a.s || a.idx - b.idx)
    .map(({ c }) => c);
}

/**
 * Honest no-match detection (spike point 3, docs/plans/track-jev-buscador-spike.md).
 * NEVER gates: callers use it only to label results, never to drop them.
 *
 * Thresholds from the 5 labeled eval queries (scripts/evals/jev-buscador/):
 * - Junk pools: top1 0.04-0.06 (lax pool) and 0.67 with tiny margin
 *   (production pool: "pantalla LED" near-duplicates for an unrelated query).
 * - Clear matches: top1 0.85-0.90 (residuos, consumibles).
 * - Rescued query: puente top1 0.63 with margin 0.19 — must NOT flag.
 * Rule: top1 < 0.75 AND margin(top1, top2) < 0.15. Single result flags if
 * top1 < 0.75. An absolute threshold alone cannot separate 0.63 (clear)
 * from 0.67 (junk); the margin does, at the cost of flagging sparse matches
 * like IA (0.46, margin 0.03) — defensible: 18/20 of that pool was noise.
 */
export function detectNoClearMatch(scores: Record<string, number>): boolean {
  const values = Object.values(scores)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  if (values.length === 0 || values[0] >= 0.75) return false;
  if (values.length === 1) return true;
  return values[0] - values[1] < 0.15;
}
