import fs from 'fs';
const KEY = fs.readFileSync('/root/.typesafe_api_key','utf8').trim();
const URL = 'https://api.typesafe.ai/v1/systemone';
const pool = JSON.parse(fs.readFileSync('/tmp/cands.json','utf8'));

async function jev(query, cands) {
  const questions = {};
  for (const c of cands) {
    questions[c.id] = {
      type: 'noul',
      instructions: `Expediente de licitación pública. Título: ${c.titulo}. Objeto: ${c.objeto}` +
        ` — ¿Encaja con lo que el usuario busca?`,
      criteria: { true: 'Encaja claramente con la búsqueda', false: 'No encaja con la búsqueda' },
    };
  }
  const r = await fetch(URL, { method:'POST',
    headers: { Authorization:`Bearer ${KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state: `Usuario buscando licitaciones públicas. Consulta: "${query}"`, questions }),
    signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const out = {};
  for (const [k,v] of Object.entries(j.answers||{})) out[k] = v.noul;
  return out;
}

const QA = 'equipos informáticos portátiles';
const QB = 'rehabilitación de fachada';
const t0 = Date.now();
const [sA, sB] = await Promise.all([jev(QA, pool), jev(QB, pool)]);
console.log(`2 llamadas JEV en ${((Date.now()-t0)/1000).toFixed(1)}s — matriz de encaje:`);
console.log('candidato'.padEnd(64), 'inf', 'fach');
for (const c of pool) {
  const a = sA[c.id], b = sB[c.id];
  console.log(c.titulo.slice(0,62).padEnd(64), (a!=null?a.toFixed(2):'—').padEnd(6), (b!=null?b.toFixed(2):'—'));
}
