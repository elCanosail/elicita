// /api/cobertura — datos live de fuentes, registros, última actualización
import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { rateLimitGuard } from '../../lib/rate-limit';
import { cachedResponse } from '../../lib/cache';

// Memo de origen (lib/cache): CF no cachea JSON — 1 lectura de disco/min por
// proceso. generatedAt queda dentro del cómputo cacheado: payload reproducible
// por TTL (el dato se materializa cada 4h).
const COBERTURA_CACHE_TTL_MS = 60_000;

const INGESTA_DIR = path.join(process.cwd(), '..', 'ingesta');
const LOGS_DIR    = path.join(INGESTA_DIR, 'logs');
const DATA_DIR    = path.join(INGESTA_DIR, 'data');

/** Parse last timestamp from a log file */
function lastLogTime(logFile: string): string | null {
  try {
    const content = fs.readFileSync(path.join(LOGS_DIR, logFile), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

/** Read total contracts from a source JSON file */
function readSourceTotal(jsonFile: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, jsonFile), 'utf8');
    const data = JSON.parse(raw);
    const total = data.total ?? data.contratos?.length ?? null;
    return typeof total === 'number' ? total : null;
  } catch {}
  return null;
}

export const GET: APIRoute = async ({ request }) => {
  const limited = rateLimitGuard(request, { name: 'public-cobertura', limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  return cachedResponse('public:cobertura:v1', COBERTURA_CACHE_TTL_MS, async () => {

  // Status file for global last run
  let globalLastRun = '';
  try {
    const status = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'status.json'), 'utf8'));
    globalLastRun = status.ultima_ejecucion ?? '';
  } catch {}

  const fuentes = [
    {
      key: 'nacional',
      name: 'PLACSP Nacional',
      description: 'Plataforma de Contratación del Sector Público. Licitaciones y adjudicaciones de la AGE, CCAA y entidades locales.',
      region: 'España',
      records: 13_419_448,
      firstData: '2002',
      lastData: '2026',
      format: 'ATOM/XML',
      frequency: 'Cada 4h',
      logFile: 'placsp.log',
      icon: '🇪🇸',
    },
    {
      key: 'ted',
      name: 'TED / DOUE',
      description: 'Tenders Electronic Daily. Contratos europeos que superan umbrales SARA (publicación obligatoria en el Diario Oficial de la UE).',
      region: 'Unión Europea',
      records: 6_478_599,
      firstData: '2010',
      lastData: '2026',
      format: 'API v3 eForms + CSV bulk',
      frequency: 'Cada 4h',
      logFile: 'ted.log',
      icon: '🇪🇺',
    },
    {
      key: 'catalunya',
      name: 'Catalunya',
      description: 'Contractació pública de la Generalitat de Catalunya. Incluye contratos mayores y menores del PSCP.',
      region: 'Catalunya',
      records: 1_995_455,
      firstData: '2012',
      lastData: '2026',
      format: 'API REST + Socrata',
      frequency: 'Cada 4h',
      logFile: 'catalunya.log',
      icon: '🏳️',
    },
    {
      key: 'comunidad_madrid',
      name: 'Comunidad de Madrid',
      description: 'Portal de contratación de la Comunidad de Madrid. Incluye todos los organismos autonómicos y entes públicos.',
      region: 'Madrid',
      records: 2_563_527,
      firstData: '2016',
      lastData: '2025',
      format: 'Web scraping + CSV',
      frequency: 'Cada 4h',
      logFile: 'madrid_cm.log',
      icon: '🏛️',
    },
    {
      key: 'madrid_ayto',
      name: 'Ayuntamiento de Madrid',
      description: 'Portal de datos abiertos del Ayuntamiento de Madrid. Incluye contratos menores y adjudicaciones del municipio.',
      region: 'Madrid',
      records: readSourceTotal('madrid_ayto_contracts.json'),
      firstData: '2015',
      lastData: '2026',
      format: 'CSV / Open Data',
      frequency: 'Cada 4h',
      logFile: 'madrid_ayto.log',
      icon: '🏙️',
    },
    {
      key: 'galicia',
      name: 'Galicia',
      description: 'Contratos de Galicia vía API REST de contratosdegalicia.gal. Licitaciones y contratos menores de la Xunta y sector público gallego.',
      region: 'Galicia',
      records: 1_685_789,
      firstData: '2007',
      lastData: '2026',
      format: 'API REST / DataTables',
      frequency: 'Cada 4h',
      logFile: 'galicia_v2.log',
      icon: '🌊',
    },
    {
      key: 'andalucia',
      name: 'Andalucía',
      description: 'Plataforma de contratación de la Junta de Andalucía. Expedientes regulares y contratos menores vía API ElasticSearch.',
      region: 'Andalucía',
      records: 808_441,
      firstData: '2008',
      lastData: '2026',
      format: 'API ElasticSearch',
      frequency: 'Cada 4h',
      logFile: 'andalucia_v2.log',
      icon: '☀️',
    },
    {
      key: 'euskadi',
      name: 'Euskadi',
      description: 'Open Data Euskadi. Contratación pública del Gobierno Vasco y entes del sector público vasco.',
      region: 'País Vasco',
      records: 713_827,
      firstData: '2005',
      lastData: '2026',
      format: 'CSV / Open Data',
      frequency: 'Cada 4h',
      logFile: 'euskadi_v2.log',
      icon: '🌿',
    },
    {
      key: 'asturias',
      name: 'Asturias',
      description: 'Contratación centralizada del Principado de Asturias. Contratos mayores y menores de la administración autonómica.',
      region: 'Asturias',
      records: 375_380,
      firstData: '2019',
      lastData: '2024',
      format: 'CSV / Open Data',
      frequency: 'Mensual',
      logFile: 'asturias.log',
      icon: '⛰️',
      updateLabel: 'Mensual',
    },
    {
      key: 'valencia',
      name: 'C. Valenciana',
      description: 'Diario Oficial de la Generalitat Valenciana. Licitaciones y adjudicaciones en tiempo real.',
      region: 'C. Valenciana',
      records: 246_337,
      firstData: '2020',
      lastData: '2026',
      format: 'API REST',
      frequency: 'Cada 4h',
      logFile: 'dogv.log',
      icon: '🍊',
    },
    // ── Feeds en tiempo real (complementan PLACSP, sin dataset histórico propio) ──
    {
      key: 'dogv',
      name: 'Valencia (DOGV)',
      description: 'Diario Oficial de la Generalitat Valenciana. Feed de licitaciones y adjudicaciones en tiempo real.',
      region: 'C. Valenciana',
      records: readSourceTotal('dogv_contracts.json'),
      firstData: '2020',
      lastData: '2026',
      format: 'API REST',
      frequency: 'Cada 4h',
      logFile: 'dogv.log',
      icon: '🍊',
    },
    {
      key: 'doga',
      name: 'Galicia (DOGA)',
      description: 'Diario Oficial de Galicia. Anuncios de licitación y adjudicación publicados en el boletín oficial gallego.',
      region: 'Galicia',
      records: readSourceTotal('doga_contracts.json'),
      firstData: '2007',
      lastData: '2026',
      format: 'ATOM/XML',
      frequency: 'Cada 4h',
      logFile: 'doga.log',
      icon: '📋',
    },
    {
      key: 'boe',
      name: 'BOE',
      description: 'Boletín Oficial del Estado. Anuncios de licitaciones y adjudicaciones de ámbito estatal en tiempo real.',
      region: 'España',
      records: readSourceTotal('boe_contracts.json'),
      firstData: '2002',
      lastData: '2026',
      format: 'API XML',
      frequency: 'Cada 4h',
      logFile: 'boe.log',
      icon: '📜',
    },
    // ── Calidad ──
    {
      key: 'calidad',
      name: 'Indicadores de calidad',
      description: '20 indicadores de validez, consistencia y fiabilidad aplicados a 8.7M contratos. Cruzan PLACSP, TED y BORME para scoring automático. Dataset histórico (última edición feb-2026).',
      region: 'España + UE',
      records: 8_693_891,
      firstData: '2012',
      lastData: '2026-02',
      format: 'Pipeline propio (BquantFinance)',
      frequency: 'Histórico',
      logFile: null,
      icon: '✅',
      updateLabel: 'Histórico (feb-2026)',
    },
    // ── BORME ──
    {
      key: 'borme_empresas',
      name: 'BORME — Empresas',
      description: 'Registro Mercantil. Actos societarios: constituciones, cambios de domicilio, ampliaciones de capital, nombramientos.',
      region: 'España',
      records: 9_254_668,
      firstData: '2009',
      lastData: '2026',
      format: 'Parquet (dataset procesado)',
      frequency: 'Mensual',
      logFile: null,
      icon: '🏢',
      updateLabel: 'Mensual',
    },
    {
      key: 'borme_cargos',
      name: 'BORME — Cargos',
      description: 'Nombramientos, ceses y dimisiones de cargos directivos publicados en el BORME. Trazabilidad de personas clave anonimizadas.',
      region: 'España',
      records: 17_101_151,
      firstData: '2009',
      lastData: '2026',
      format: 'Parquet (dataset procesado)',
      frequency: 'Mensual',
      logFile: null,
      icon: '👔',
      updateLabel: 'Mensual',
    },
  ];

  // Resolve last update time for each source
  const result = fuentes.map(f => {
    let lastUpdate: string | null = null;
    if (f.logFile) {
      lastUpdate = lastLogTime(f.logFile);
    }
    return {
      ...f,
      logFile: undefined,
      lastUpdate,
    };
  });

  const totalRecords = fuentes.reduce((sum, f) => sum + (f.records ?? 0), 0);

  return new Response(JSON.stringify({
    fuentes: result,
    totalRecords,
    globalLastRun,
    generatedAt: new Date().toISOString(),
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, s-maxage=60',
    },
  });
  });
};
