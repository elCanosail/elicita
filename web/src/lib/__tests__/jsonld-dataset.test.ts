import { describe, expect, it } from 'vitest';
import {
  DATASET_ARTIFACT_FILES,
  buildOpenDataDatasetJsonLd,
  type DatasetLicense,
} from '../jsonld-dataset';
import { MARKET_INTELLIGENCE_DATASETS } from '../market-intelligence';

const DESCRIPTION =
  '63M+ registros oficiales —contratación y mercantil— de 16 fuentes, 7 sectores publicados con métricas y actualización cada 4 horas.';
const LICENSE: DatasetLicense = {
  name: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
};
const DATE_MODIFIED = '2026-10-13T04:54:49.577Z';

describe('lib/jsonld-dataset', () => {
  it('produce un bloque schema.org/Dataset serializable', () => {
    const jsonLd = buildOpenDataDatasetJsonLd({
      description: DESCRIPTION,
      license: LICENSE,
      dateModified: DATE_MODIFIED,
    });
    // JSON.parse(JSON.stringify(...)): la serialización que incrusta la página
    // es parseable y estable (sin undefined colgantes ni referencias).
    const roundTrip = JSON.parse(JSON.stringify(jsonLd));
    expect(roundTrip['@context']).toBe('https://schema.org');
    expect(roundTrip['@type']).toBe('Dataset');
    expect(roundTrip.url).toBe('https://elicita.es/cobertura');
    expect(roundTrip.creator).toEqual({
      '@type': 'Organization',
      name: 'elicita_',
      url: 'https://elicita.es',
    });
  });

  it('distribution: 21 artifacts (7 sectores × 3 ficheros), URLs absolutas y formatos correctos', () => {
    const jsonLd = buildOpenDataDatasetJsonLd({ description: DESCRIPTION });
    expect(jsonLd.distribution).toHaveLength(
      MARKET_INTELLIGENCE_DATASETS.length * DATASET_ARTIFACT_FILES.length,
    );
    expect(MARKET_INTELLIGENCE_DATASETS).toHaveLength(7);
    const sectors = new Set(
      jsonLd.distribution.map((d) => {
        const m = d.contentURL.match(/market-intelligence\/([^/]+)\/latest\//);
        expect(m).not.toBeNull();
        return m![1];
      }),
    );
    expect([...sectors].sort()).toEqual([...MARKET_INTELLIGENCE_DATASETS].sort());
    for (const d of jsonLd.distribution) {
      expect(d['@type']).toBe('DataDownload');
      expect(d.contentURL.startsWith('https://elicita.es/')).toBe(true);
      expect(d.encodingFormat).toMatch(/^(text\/csv|application\/json)$/);
    }
    expect(
      jsonLd.distribution.filter((d) => d.contentURL.endsWith('generation-receipt.json')),
    ).toHaveLength(7);
  });

  it('license y dateModified se omiten si no hay artifact que los respalde (nunca se inventan)', () => {
    const jsonLd = buildOpenDataDatasetJsonLd({ description: DESCRIPTION });
    expect(jsonLd.license).toBeUndefined();
    expect(jsonLd.dateModified).toBeUndefined();
    expect(jsonLd).not.toHaveProperty('license');
    expect(jsonLd).not.toHaveProperty('dateModified');
  });

  it('license proviene del snapshot.json publicado y dateModified es ISO válido', () => {
    const jsonLd = buildOpenDataDatasetJsonLd({
      description: DESCRIPTION,
      license: LICENSE,
      dateModified: DATE_MODIFIED,
    });
    expect(jsonLd.license).toEqual({ '@type': 'CreativeWork', ...LICENSE });
    expect(Number.isNaN(new Date(jsonLd.dateModified!).getTime())).toBe(false);
    expect(jsonLd.dateModified).toBe(DATE_MODIFIED);
  });

  it('temporalCoverage abre en 2002 y el extremo final queda abierto', () => {
    const jsonLd = buildOpenDataDatasetJsonLd({ description: DESCRIPTION });
    expect(jsonLd.temporalCoverage).toBe('2002-01-01/..');
  });

  it('spatialCoverage es España, verificado (sin enumeraciones sin artifact)', () => {
    const jsonLd = buildOpenDataDatasetJsonLd({ description: DESCRIPTION });
    expect(jsonLd.spatialCoverage).toEqual([{ '@type': 'Place', name: 'España' }]);
  });

  it('isAccessibleForFree y idioma coherentes con la capa pública', () => {
    const jsonLd = buildOpenDataDatasetJsonLd({ description: DESCRIPTION });
    expect(jsonLd.isAccessibleForFree).toBe(true);
    expect(jsonLd.inLanguage).toBe('es');
  });
});
