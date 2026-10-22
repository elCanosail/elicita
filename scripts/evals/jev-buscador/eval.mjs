import fs from 'fs';
const KEY = fs.readFileSync('/root/.typesafe_api_key','utf8').trim();
const { pares } = JSON.parse(fs.readFileSync(new URL('./eval.json', import.meta.url)));

function ip(n) { return `172.19.${40 + (n % 5)}.${10 + n}`; }

async function classic(q, n) {
  const r = await fetch(`http://127.0.0.1:4321/api/public/search?q=${encodeURIComponent(q)}&limit=${n}`,
    { headers: { 'X-Forwarded-For': ip(n) } });
  const j = await r.json();
  return j.results || [];
}

async function jevRank(q, cands) {
  const questions = {};
  for (const c of cands) {
    questions[c.id] = {
      type: 'noul',
      instructions: `Expediente de licitación pública. Título/objeto: ${(c.titulo||'').slice(0,300)}. ` +
        `— ¿Corresponde a lo que el usuario está buscando?`,
      criteria: { true: 'Corresponde claramente a la necesidad del usuario', false: 'No corresponde a lo buscado' },
    };
  }
  const r = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: 'jev-latest', state: `Usuario buscando licitaciones públicas. Consulta: "${q}"`, questions }),
    signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0,200)}`);
  const j = await r.json();
  const out = {};
  for (const [k, v] of Object.entries(j.answers || {})) out[k] = v.noul;
  return out;
}

const resultados = [];
let jevMs = 0;
for (let i = 0; i < pares.length; i++) {
  const { q, target } = pares[i];
  const cands = await classic(q, 20);
  const ids = cands.map(c => c.id);
  const classicRank = ids.indexOf(target); // 0-based; -1 si no está
  let jevRank = -1, t = 0;
  if (cands.length >= 2) {
    t = Date.now();
    const scores = await jevRank(q, cands);
    jevMs += Date.now() - t;
    const orden = cands.map((c, idx) => ({ id: c.id, s: scores[c.id] ?? 0, idx }))
      .sort((a, b) => b.s - a.s || a.idx - b.idx);
    jevRank = orden.findIndex(o => o.id === target);
  }
  resultados.push({ q, target, classic: classicRank, jev: jevRank, nCands: cands.length });
  console.log(`${String(i+1).padStart(2)}. clásico=${classicRank === -1 ? 'fuera' : '#' + (classicRank+1)} → jev=${jevRank === -1 ? 'fuera' : '#' + (jevRank+1)}  (${q.slice(0,45)})`);
  await new Promise(r => setTimeout(r, 300));
}

function mrr(ranks) { // rank 0-based
  const rr = ranks.filter(r => r >= 0).map(r => 1 / (r + 1));
  return rr.length ? (rr.reduce((a,b)=>a+b,0) / ranks.length) : 0;
}
function recall(ranks, k) { return ranks.filter(r => r >= 0 && r < k).length / ranks.length; }
const c = resultados.map(r => r.classic), j = resultados.map(r => r.jev);
console.log('\n=== MÉTRICAS (12 consultas, top-20 clásico) ===');
console.log(`Target recuperado por clásico: ${c.filter(r=>r>=0).length}/12`);
console.log(`MRR clásico: ${mrr(c).toFixed(3)}  |  MRR jev: ${mrr(j).toFixed(3)}`);
console.log(`recall@5  clásico: ${recall(c,5).toFixed(2)}  |  jev: ${recall(j,5).toFixed(2)}`);
console.log(`recall@10 clásico: ${recall(c,10).toFixed(2)}  |  jev: ${recall(j,10).toFixed(2)}`);
console.log(`latencia media JEV: ${(jevMs/pares.length).toFixed(0)}ms  |  coste total ~$${(pares.length*0.0002).toFixed(4)}`);
fs.writeFileSync(new URL('./eval-results.json', import.meta.url), JSON.stringify(resultados, null, 2));
