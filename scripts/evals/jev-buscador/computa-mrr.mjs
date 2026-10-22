/**
 * Computa MRR y recall@5 sobre mrr-eval.json usando las etiquetas de
 * labels.json (juicio por título). Compara orden clásico (búsqueda
 * tokenizada, tal como sale de producción) vs orden tras re-ranking JEV.
 */
import fs from 'fs';

const evalData = JSON.parse(
  fs.readFileSync(new URL('./mrr-eval.json', import.meta.url), 'utf8')
);
const labels = JSON.parse(
  fs.readFileSync(new URL('./labels.json', import.meta.url), 'utf8')
);

function metricas(ordenIds, relevantes) {
  if (relevantes.size === 0) return { mrr: null, recall5: null };
  const rank1 = ordenIds.findIndex((id) => relevantes.has(id));
  const mrr = rank1 === -1 ? 0 : 1 / (rank1 + 1);
  const enTop5 = ordenIds.slice(0, 5).filter((id) => relevantes.has(id)).length;
  return { mrr, recall5: enTop5 / relevantes.size };
}

const filas = [];
let mrrC = 0, mrrJ = 0, r5C = 0, r5J = 0, n = 0;
let jevMsTotal = 0;

for (const q of labels.queries) {
  const e = evalData.find((x) => x.q === q.q && !x.error);
  if (!e) { console.log(`[skip] ${q.q} — sin datos`); continue; }
  const relevantes = new Set(q.relevant_idx.map((i) => e.classic[i].id));
  const mc = metricas(e.classic.map((c) => c.id), relevantes);
  const mj = metricas(e.jev.map((c) => c.id), relevantes);
  jevMsTotal += e.jevMs || 0;
  if (mc.mrr !== null) {
    mrrC += mc.mrr; mrrJ += mj.mrr; r5C += mc.recall5; r5J += mj.recall5; n++;
  }
  const fmt = (v) => (v === null ? '—' : v.toFixed(3));
  console.log(`\n${q.q}`);
  console.log(`  relevantes: ${relevantes.size}/${e.poolSize}`);
  console.log(`  clásico:  MRR ${fmt(mc.mrr)}  recall@5 ${fmt(mc.recall5)}`);
  console.log(`  JEV:      MRR ${fmt(mj.mrr)}  recall@5 ${fmt(mj.recall5)}`);
  console.log(`  ${q.nota || ''}`);
}

console.log(`\n=== RESUMEN (${n} consultas con relevantes) ===`);
console.log(`MRR       clásico ${(mrrC / n).toFixed(3)}  →  JEV ${(mrrJ / n).toFixed(3)}`);
console.log(`recall@5  clásico ${(r5C / n).toFixed(3)}  →  JEV ${(r5J / n).toFixed(3)}`);
console.log(`latencia JEV media: ${(jevMsTotal / evalData.filter((e) => !e.error).length).toFixed(0)} ms`);

fs.writeFileSync(
  new URL('./mrr-results.json', import.meta.url),
  JSON.stringify({
    fecha: new Date().toISOString(),
    n_consultas: labels.queries.length,
    n_con_relevantes: n,
    mrr_clasico: mrrC / n,
    mrr_jev: mrrJ / n,
    recall5_clasico: r5C / n,
    recall5_jev: r5J / n,
    jev_ms_media: jevMsTotal / evalData.filter((e) => !e.error).length,
  }, null, 2)
);
console.log('-> mrr-results.json');
