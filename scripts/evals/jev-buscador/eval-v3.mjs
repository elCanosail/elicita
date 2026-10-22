import fs from 'fs';
const KEY = fs.readFileSync('/root/.typesafe_api_key','utf8').trim();
const STOP = new Set(['para','de','del','la','el','los','las','en','y','un','una','con','por','su','sus']);
const QUERIES = [
  'equipamiento de laboratorio de investigación en inteligencia artificial',
  'luces LED para embalses y presas',
  'gestión de residuos tóxicos generados por un laboratorio',
  'consumibles y aparatos de análisis para laboratorio de hospital',
  'arreglo de puente en carretera de montaña',
];
function ip(n) { return `172.30.${(n % 8) + 1}.${10 + n}`; }
async function search(q, ipn, limit = 8) {
  const r = await fetch(`http://127.0.0.1:4321/api/public/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    { headers: { 'X-Forwarded-For': ip(ipn) } });
  const j = await r.json();
  return j.results || [];
}
async function jev(q, cands) {
  const questions = {};
  for (const c of cands) {
    questions[c.id] = { type: 'noul',
      instructions: `Expediente de licitación pública. Título/objeto: ${(c.titulo||'').slice(0,300)}. — ¿Corresponde a lo que el usuario busca?`,
      criteria: { true: 'Corresponde claramente a la necesidad del usuario', false: 'No corresponde a lo buscado' } };
  }
  const t = Date.now();
  const r = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state: `Usuario buscando licitaciones públicas. Consulta: "${q}"`, questions }),
    signal: AbortSignal.timeout(60000) });
  const ms = Date.now() - t;
  if (!r.ok) throw new Error(`API ${r.status}`);
  const j = await r.json();
  const out = {};
  for (const [k, v] of Object.entries(j.answers || {})) out[k] = v.noul;
  return { scores: out, ms };
}
let ipn = 0, msTotal = 0, calls = 0;
const full = [];
for (const q of QUERIES) {
  const hoy = await search(q, ipn++, 20);
  const words = [...new Set(q.split(/\s+/).filter(w => w.length > 3 && !STOP.has(w.toLowerCase())))];
  const merged = new Map();
  for (const w of words) {
    for (const r of await search(w, ipn++, 8)) if (!merged.has(r.id)) merged.set(r.id, r);
  }
  const pool = [...merged.values()];
  let top5 = [];
  if (pool.length >= 2) {
    const { scores, ms } = await jev(q, pool);
    msTotal += ms; calls++;
    top5 = pool.map(c => ({ id: c.id, titulo: (c.titulo||'').slice(0,75), s: scores[c.id] ?? 0 }))
      .sort((a,b) => b.s - a.s).slice(0, 5);
  }
  full.push({ q, hoyCount: hoy.length, poolSize: pool.length, top5 });
  console.log(`\n[${q}]`);
  console.log(`  HOY (frase exacta): ${hoy.length} resultados  |  pool laxo: ${pool.length} candidatos`);
  top5.forEach((t, n) => console.log(`   jev#${n+1} ${t.s.toFixed(2)} ${t.id.padEnd(26)} ${t.titulo}`));
  await new Promise(r => setTimeout(r, 250));
}
console.log(`\nJEV: ${calls} llamadas, media ${(msTotal/Math.max(calls,1)).toFixed(0)}ms`);
fs.writeFileSync(new URL('./eval-v3-results.json', import.meta.url), JSON.stringify(full, null, 2));
