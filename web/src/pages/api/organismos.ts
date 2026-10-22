import type { APIRoute } from 'astro';
import fs from 'fs';
import path from 'path';
import { normEstado } from '../../lib/duckdb';
import { requireAuth } from '../../lib/api-auth';

function extractText(val: any, langPriority = ['spa', 'eng']): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    for (const lang of langPriority) {
      const found = val.find((item: any) => {
        const l = item?.['@language']?.toLowerCase() || item?.['@xml:lang']?.toLowerCase();
        return l === lang || l?.startsWith(lang);
      });
      if (found) return extractText(found);
    }
    return extractText(val[0]);
  }
  if (typeof val === 'object') {
    if (val['#text']) return val['#text'];
    for (const lang of langPriority) {
      if (val[lang]) {
        const v = val[lang];
        return String(Array.isArray(v) ? extractText(v[0]) : v);
      }
    }
    return JSON.stringify(val);
  }
  return String(val);
}

const ACTIVE_ESTADOS = new Set([
  'abierta', 'publicada', 'anuncio_previo', 'evaluacion', 'evaluación', 'en_curso',
]);

const TERMINAL_ESTADOS = new Set([
  'adjudicada', 'resuelta', 'formalizada', 'desierta', 'anulada',
]);


export const GET: APIRoute = async ({ url: reqUrl, locals }) => {
  const { error } = requireAuth(locals);
  if (error) return error;
  const mode = reqUrl.searchParams.get('mode') || 'activas'; // 'activas' | 'terminales' | 'all'
  const estadoFilter = mode === 'terminales' ? TERMINAL_ESTADOS
                     : mode === 'all' ? null
                     : ACTIVE_ESTADOS;

  const ingestaDir = path.join(process.cwd(), '..', 'ingesta', 'data');
  const orgCount = new Map<string, number>();

  try {
    const files = fs.readdirSync(ingestaDir).filter(f => f.endsWith('_contracts.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(ingestaDir, file), 'utf-8'));
        const contratos = data.contratos || [];
        for (const c of contratos) {
          if (estadoFilter) {
            const estado = normEstado(c.estado || '');
            if (!estadoFilter.has(estado)) continue;
          }
          const org = (extractText(c.organismo) || 'Organismo no especificado').trim();
          orgCount.set(org, (orgCount.get(org) || 0) + 1);
        }
      } catch { /* skip broken file */ }
    }
  } catch { /* ingesta dir not found */ }

  const organismos = Array.from(orgCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([nombre, count]) => ({ nombre, count }));

  return new Response(JSON.stringify({ organismos, total: organismos.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
};
