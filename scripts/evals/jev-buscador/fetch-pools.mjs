import fs from 'fs';
const { pares } = JSON.parse(fs.readFileSync(new URL('./eval.json', import.meta.url)));
const out = [];
for (let i = 0; i < pares.length; i++) {
  const { q } = pares[i];
  const r = await fetch(`http://127.0.0.1:4321/api/public/search?q=${encodeURIComponent(q)}&limit=20`,
    { headers: { 'X-Forwarded-For': `172.21.${i+1}.7` } });
  const j = await r.json();
  const pool = (j.results || []).map(c => ({ id: c.id, titulo: (c.titulo || '').slice(0, 90) }));
  out.push({ q, pool });
  console.log(`\n[${i+1}] ${q}`);
  pool.forEach((c, n) => console.log(`   ${String(n+1).padStart(2)}. ${c.id.padEnd(28)} ${c.titulo}`));
  await new Promise(r => setTimeout(r, 250));
}
fs.writeFileSync(new URL('./pools.json', import.meta.url), JSON.stringify(out, null, 2));
