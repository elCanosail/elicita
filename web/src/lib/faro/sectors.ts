import { CONSTRUCTION_DATASET, DEFENSA_DATASET, ENERGY_DATASET, HEALTH_DATASET, LIMPIEZA_DATASET, TECHNOLOGY_DATASET, TRANSPORTE_DATASET, marketIntelligenceLatestPath, type MarketIntelligenceDataset } from '@/lib/market-intelligence';

/**
 * Registro de sectores FARO. La plantilla /mercado/[sector] genera una página
 * prerenderizada por entrada; la home itera este registro para el índice de fichas.
 * Cada entrada resuelve su snapshot publicado vía /data/market-intelligence/<dataset>/latest.
 */
export type SectorDef = {
  /** id del dataset en los snapshots aprobados */
  dataset: MarketIntelligenceDataset;
  /** slug de la URL pública: /mercado/<slug> */
  slug: string;
  /** nombre en prosa (minúsculas), tal como aparece en titular y metadata */
  name: string;
  /** nombre en Title Case para tarjetas de índice */
  nameTitle: string;
  /** titular h1 del hero */
  heroTitle: string;
  /** línea del estado "sin snapshot publicado" */
  fallbackLine: string;
  /** ruta pública del último snapshot publicado (descargas del sello) */
  publicLatestPath: string;
};

export const SECTORS: SectorDef[] = [
  {
    dataset: TECHNOLOGY_DATASET,
    slug: 'tecnologia',
    name: 'tecnología y telecomunicaciones',
    nameTitle: 'Tecnología y telecomunicaciones',
    heroTitle: 'El mercado tecnológico de la contratación pública española',
    fallbackLine: 'La ficha de tecnología se publicará con el próximo snapshot aprobado.',
    publicLatestPath: marketIntelligenceLatestPath(TECHNOLOGY_DATASET),
  },
  {
    dataset: CONSTRUCTION_DATASET,
    slug: 'construccion',
    name: 'construcción y obra civil',
    nameTitle: 'Construcción y obra civil',
    heroTitle: 'El mercado de la construcción en la contratación pública española',
    fallbackLine: 'La ficha de construcción se publicará con el próximo snapshot aprobado.',
    publicLatestPath: marketIntelligenceLatestPath(CONSTRUCTION_DATASET),
  },
  {
    dataset: HEALTH_DATASET,
    slug: 'salud',
    name: 'salud',
    nameTitle: 'Salud',
    heroTitle: 'El mercado de la salud en la contratación pública española',
    fallbackLine: 'La ficha de salud se publicará con el próximo snapshot aprobado.',
    publicLatestPath: marketIntelligenceLatestPath(HEALTH_DATASET),
  },
  {
    dataset: ENERGY_DATASET,
    slug: 'energia',
    name: 'energía y equipamiento eléctrico',
    nameTitle: 'Energía y equipamiento eléctrico',
    heroTitle: 'El mercado de la energía en la contratación pública española',
    fallbackLine: 'La ficha de energía se publicará con el próximo snapshot aprobado.',
    publicLatestPath: marketIntelligenceLatestPath(ENERGY_DATASET),
  },
  {
    dataset: LIMPIEZA_DATASET,
    slug: 'limpieza',
    name: 'limpieza, residuos y medio ambiente',
    nameTitle: 'Limpieza, residuos y medio ambiente',
    heroTitle: 'El mercado de la limpieza y los residuos en la contratación pública española',
    fallbackLine: 'La ficha de limpieza se publicará con el próximo snapshot aprobado.',
    publicLatestPath: marketIntelligenceLatestPath(LIMPIEZA_DATASET),
  },
  {
    dataset: DEFENSA_DATASET,
    slug: 'defensa',
    name: 'defensa y armamento',
    nameTitle: 'Defensa y armamento',
    heroTitle: 'El mercado de la defensa y el armamento en la contratación pública española',
    fallbackLine: 'La ficha de defensa se publicará con el próximo snapshot aprobado.',
    publicLatestPath: marketIntelligenceLatestPath(DEFENSA_DATASET),
  },
  {
    dataset: TRANSPORTE_DATASET,
    slug: 'transporte',
    name: 'transporte',
    nameTitle: 'Transporte',
    heroTitle: 'El mercado del transporte en la contratación pública española',
    fallbackLine: 'La ficha de transporte se publicará con el próximo snapshot aprobado.',
    publicLatestPath: marketIntelligenceLatestPath(TRANSPORTE_DATASET),
  },
];

export function sectorBySlug(slug: string): SectorDef | undefined {
  return SECTORS.find((s) => s.slug === slug);
}
