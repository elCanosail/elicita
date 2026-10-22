// /api/stats — estadísticas vivas del dataset y pipeline
// Combina cifras DuckDB pre-computadas (históricas) con pipeline JSON (tiempo real)

import type { APIRoute } from 'astro';
import fs from 'fs';
import path from 'path';
import { rateLimitGuard } from '../../lib/rate-limit';

// In-memory cache (process lifetime) para evitar re-lecturas de archivos JSON
let statsCache: { data: any; timestamp: number } | null = null;
const STATS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

export const GET: APIRoute = async ({ request }) => {
  const limited = rateLimitGuard(request, { name: 'public-stats', limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  const now = Date.now();
  if (statsCache && (now - statsCache.timestamp) < STATS_CACHE_TTL_MS) {
    return new Response(JSON.stringify(statsCache.data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
    });
  }

  const pipelineDir = path.join(process.cwd(), '..', 'ingesta', 'data');

  // ── Pipeline real-time ────────────────────────────────────────────
  const pipeline: Record<string, number> = {};
  let totalRT = 0;
  let lastUpdate = '';

  try {
    const files = fs.readdirSync(pipelineDir).filter(f => f.endsWith('_contracts.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(pipelineDir, file), 'utf8'));
        const n = data.total ?? data.contratos?.length ?? 0;
        const key = file.replace('_contracts.json', '');
        pipeline[key] = n;
        totalRT += n;
      } catch {}
    }
    const status = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'status.json'), 'utf8'));
    lastUpdate = status.ultima_ejecucion ?? '';
  } catch {}

  // ── Estado distribution from pipeline ────────────────────────────
  const estadoMap: Record<string, number> = {};
  try {
    const files = fs.readdirSync(pipelineDir).filter(f => f.endsWith('_contracts.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(pipelineDir, file), 'utf8'));
        for (const c of (data.contratos || [])) {
          const e = (c.estado || 'desconocido').toLowerCase();
          estadoMap[e] = (estadoMap[e] || 0) + 1;
        }
      } catch {}
    }
  } catch {}

  // ── Static DuckDB stats (pre-computed, refreshed on deploy) ──────
  const byYear = [
    { year: 2015, count: 69_772,    meur: 36_751  },
    { year: 2016, count: 121_618,   meur: 39_540  },
    { year: 2017, count: 193_677,   meur: 70_018  },
    { year: 2018, count: 722_236,   meur: 161_661 },
    { year: 2019, count: 1_173_844, meur: 190_747 },
    { year: 2020, count: 1_162_296, meur: 656_524 },
    { year: 2021, count: 1_529_828, meur: 249_046 },
    { year: 2022, count: 1_842_829, meur: 439_869 },
    { year: 2023, count: 2_051_345, meur: 278_949 },
    { year: 2024, count: 2_114_910, meur: 247_594 },
    { year: 2025, count: 2_194_615, meur: 258_815 },
  ];

  const byTipo = [
    { tipo: 'Servicios',   count: 6_409_901 },
    { tipo: 'Suministros', count: 4_872_399 },
    { tipo: 'Obras',       count: 1_641_040 },
    { tipo: 'Privado',     count:   226_490 },
    { tipo: 'Patrimonial', count:   105_331 },
  ];

  const topCpvs = [
    { cpv: '45000000', name: 'Construcción',            count: 152_403 },
    { cpv: '79341000', name: 'Publicidad',               count: 139_173 },
    { cpv: '50000000', name: 'Mantenimiento',            count: 128_755 },
    { cpv: '92000000', name: 'Ocio y cultura',           count: 116_265 },
    { cpv: '85100000', name: 'Servicios sanitarios',     count:  86_218 },
    { cpv: '71000000', name: 'Arquitectura/Ingeniería',  count:  84_046 },
    { cpv: '48000000', name: 'Software',                 count:  67_655 },
    { cpv: '72000000', name: 'Servicios TI',             count:  67_535 },
  ];

  const sources = [
    { key: 'nacional',        name: 'PLACSP Nacional',  count: 13_419_448, region: 'España' },
    { key: 'ted',             name: 'TED / DOUE',       count:  6_478_599, region: 'UE' },
    { key: 'comunidad_madrid',name: 'Madrid CM',        count:  2_563_527, region: 'Madrid' },
    { key: 'galicia',         name: 'Galicia',          count:  1_685_789, region: 'Galicia' },
    { key: 'andalucia',       name: 'Andalucía',        count:    808_441, region: 'Andalucía' },
    { key: 'euskadi',         name: 'Euskadi',          count:    713_827, region: 'Euskadi' },
    { key: 'asturias',        name: 'Asturias',         count:    375_380, region: 'Asturias' },
  ];

  const response = {
    pipeline,
    totalRT,
    lastUpdate,
    estadoMap,
    byYear,
    byTipo,
    topCpvs,
    sources,
    totalHistorical: 30_850_330,
    totalBorme: 26_355_819,
    generatedAt: new Date().toISOString(),
  };

  statsCache = { data: response, timestamp: Date.now() };

  return new Response(JSON.stringify(response), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, s-maxage=300', // 5 min cache
    },
  });
};
