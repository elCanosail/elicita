// JSON-LD schema.org/Dataset para la capa de datos abiertos.
// Spec: docs/plans/propuestas-2026-10-07-1600.md, propuesta B (tarea 33).
// Regla FARO: ninguna cifra nueva — la description es la afirmación canónica
// ya verificada contra el registro vivo (tarea 18: 63.356.633 = suma exacta de
// las 16 fuentes); la licencia proviene del snapshot.json publicado (misma
// regla de la tarea 10: nunca inventar la licencia); las distribution son las
// 21 URLs de artifacts verificadas en la tarea 10 (7 sectores × 3 ficheros).

import { MARKET_INTELLIGENCE_DATASETS } from './market-intelligence';

export const SITE_URL = 'https://elicita.es';

// Artifacts por sector publicados en /data/market-intelligence/<sector>/latest/
// (tabla «Artifacts publicados por snapshot» de /docs/metodologia, 21/21 URLs
// verificadas en producción el 30-09-2026, tarea 10).
export const DATASET_ARTIFACT_FILES = [
  { filename: 'coverage.csv', encodingFormat: 'text/csv' },
  { filename: 'exclusions.csv', encodingFormat: 'text/csv' },
  { filename: 'generation-receipt.json', encodingFormat: 'application/json' },
] as const;

export type DatasetLicense = { name: string; url: string };

export type DatasetJsonLd = {
  '@context': 'https://schema.org';
  '@type': 'Dataset';
  name: string;
  description: string;
  url: string;
  inLanguage: string;
  isAccessibleForFree: boolean;
  creator: { '@type': 'Organization'; name: string; url: string };
  license?: { '@type': 'CreativeWork'; name: string; url: string };
  temporalCoverage: string;
  spatialCoverage: { '@type': 'Place'; name: string }[];
  distribution: {
    '@type': 'DataDownload';
    contentURL: string;
    encodingFormat: string;
  }[];
  dateModified?: string;
};

/**
 * Bloque canónico del dataset abierto. /cobertura es la URL canónica; la misma
 * tarjeta se incrusta en /datos-abiertos. Campos opcionales (license,
 * dateModified) se omiten si no hay artifact que los respalde — nunca se
 * inventan.
 */
export function buildOpenDataDatasetJsonLd(input: {
  description: string;
  license?: DatasetLicense | null;
  dateModified?: string | null;
  baseUrl?: string;
}): DatasetJsonLd {
  const baseUrl = input.baseUrl ?? SITE_URL;
  const jsonLd: DatasetJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'elicita_ — datos abiertos de contratación pública y registro mercantil de España',
    description: input.description,
    url: `${baseUrl}/cobertura`,
    inLanguage: 'es',
    isAccessibleForFree: true,
    creator: { '@type': 'Organization', name: 'elicita_', url: baseUrl },
    // Primer registro 2002 (verificado contra la API en la tarea 18); extremo
    // abierto: el dataset sigue creciendo con cada ciclo de 4h.
    temporalCoverage: '2002-01-01/..',
    spatialCoverage: [{ '@type': 'Place', name: 'España' }],
    distribution: MARKET_INTELLIGENCE_DATASETS.flatMap((sector) =>
      DATASET_ARTIFACT_FILES.map(({ filename, encodingFormat }) => ({
        '@type': 'DataDownload' as const,
        contentURL: `${baseUrl}/data/market-intelligence/${sector}/latest/${filename}`,
        encodingFormat,
      })),
    ),
  };
  if (input.license) {
    jsonLd.license = {
      '@type': 'CreativeWork',
      name: input.license.name,
      url: input.license.url,
    };
  }
  if (input.dateModified) {
    jsonLd.dateModified = input.dateModified;
  }
  return jsonLd;
}

/**
 * Contexto respaldado por artifacts para el Dataset JSON-LD: licencia del
 * snapshot.json publicado y dateModified desde ingesta/data/status.json
 * (la «última lectura» que ya surfacean cobertura/estadisticas). Cualquier
 * fallo de lectura degrada a null — el campo se omite, nunca se inventa.
 */
export async function loadDatasetContext(): Promise<{
  license: DatasetLicense | null;
  dateModified: string | null;
}> {
  const { loadPublishedMarketSnapshot } = await import('./market-intelligence');
  const publication = await loadPublishedMarketSnapshot();
  const license =
    publication.status === 'published'
      ? {
          name: publication.value.snapshot.license.name,
          url: publication.value.snapshot.license.url,
        }
      : null;

  let dateModified: string | null = null;
  try {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const raw = readFileSync(
      join(process.cwd(), '..', 'ingesta', 'data', 'status.json'),
      'utf8',
    );
    const parsed: unknown = JSON.parse(raw);
    const ultima = (parsed as { ultima_ejecucion?: unknown })?.ultima_ejecucion;
    if (typeof ultima === 'string' && !Number.isNaN(new Date(ultima).getTime())) {
      dateModified = new Date(ultima).toISOString();
    }
  } catch {
    dateModified = null;
  }

  return { license, dateModified };
}
