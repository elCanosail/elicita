/**
 * Eval MRR / recall@5 — orden clásico (tokenizado) vs JEV re-rank.
 *
 * Pool: /api/public/search limit 20 (comportamiento actual de producción,
 * búsqueda tokenizada). JEV re-rankea ese pool con el mismo prompt que
 * web/src/lib/jev-rerank.ts. Etiquetas de ground truth en labels.json
 * (juicio por título: ¿responde claramente a la consulta?).
 *
 * Salida: mrr-eval.json (órdenes y scores) — las métricas se calculan en
 * computa-mrr.mjs sobre labels.json.
 */
import fs from 'fs';
const KEY = fs.readFileSync('/root/.typesafe_api_key', 'utf8').trim();

const QUERIES = [
  'gestión de residuos tóxicos generados por un laboratorio',
  'consumibles y aparatos de análisis para laboratorio de hospital',
  'equipamiento de laboratorio de investigación en inteligencia artificial',
  'arreglo de puente en carretera de montaña',
  'luces LED para embalses y presas',
];

function ip(n) { return `172.30.${(n % 8) + 1}.${10 + n}`; }

async function pool(q, ipn, limit = 20) {
  const r = await fetch(
    `http://127.0.0.1:4321/api/public/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    { headers: { 'X-Forwarded-For': ip(ipn) } }
  );
  const j = await r.json();
  return j.results || [];
}

async function jev(q, cands) {
  const questions = {};
  for (const c of cands) {
    questions[c.id] = {
      type: 'noul',
      instructions: `Expediente de licitación pública. Título/objeto: ${String(c.titulo || '').slice(0, 300)}. — ¿Corresponde a lo que el usuario busca?`,
      criteria: {
        true: 'Corresponde claramente a la necesidad del usuario',
        false: 'No corresponde a lo buscado',
      },
    };
  }
  const t = Date.now();
  const r = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: `Usuario buscando licitaciones públicas. Consulta: "${q}"`,
      questions,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const ms = Date.now() - t;
  if (!r.ok) throw new Error(`API ${r.status}`);
  const j = await r.json();
  const scores = {};
  for (const [k, v] of Object.entries(j.answers || {})) scores[k] = v.noul ?? 0;
  return { scores, ms };
}

let ipn = 0;
const out = [];
for (const q of QUERIES) {
  const cands = await pool(q, ipn++);
  if (cands.length < 2) {
    out.push({ q, pool: cands, error: 'pool < 2' });
    continue;
  }
  const { scores, ms } = await jev(q, cands);
  const jevOrder = cands
    .map((c, idx) => ({ id: c.id, s: scores[c.id] ?? 0, idx }))
    .sort((a, b) => b.s - a.s || a.idx - b.idx);
  out.push({
    q,
    poolSize: cands.length,
    jevMs: ms,
    classic: cands.map((c) => ({ id: c.id, titulo: (c.titulo || '').slice(0, 110) })),
    jev: jevOrder.map((o) => ({ id: o.id, s: Math.round(o.s * 100) / 100 })),
  });
  console.log(`\n[${q}] pool ${cands.length}, jev ${ms}ms`);
  jevOrder.slice(0, 5).forEach((o, n) => {
    const c = cands.find((x) => x.id === o.id);
    console.log(`  jev#${n + 1} ${o.s.toFixed(2)} ${o.id.slice(0, 28).padEnd(28)} ${(c?.titulo || '').slice(0, 70)}`);
  });
  await new Promise((r) => setTimeout(r, 250));
}

fs.writeFileSync(new URL('./mrr-eval.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\n-> mrr-eval.json');
