/**
 * Synthetic test fixtures for radar inventory validation.
 *
 * ⚠️  SYNTHETIC DATA — NOT real opportunities, NOT production records.
 * These fixtures exercise validation rules and semantic contracts.
 * They must NOT be counted as real opportunities in any metric.
 *
 * Each fixture documents WHY each field has its value, tracing back
 * to the unified view schema and the temporal contract review.
 *
 * Coherence contract:
 * - not_estimable => no estimated_end_date, no basis.
 * - contractual_scenario => basis=explicit_start + fecha_inicio + duracion.
 * - award_proxy_scenario => basis=explicit_award_proxy + duracion + award
 *   anchor (fecha_adjudicacion, or fecha_fin for sources whose fecha_fin
 *   is an award/formalization date — TED/CATALUNYA/VALENCIA).
 */

import type { RadarRecord, SourceName } from './inventory';

// ─── Helpers ─────────────────────────────────────────────────────────

function fixtureId(source: SourceName, idx: number): string {
  return `SYNTH-${source}-${idx}`;
}

// ─── Positive fixtures ───────────────────────────────────────────────

/** PLACSP: fecha_fin = fecha_limite (presentation deadline), NOT award */
export const FIXTURE_PLACSP_DEADLINE: RadarRecord = {
  id: fixtureId('PLACSP', 1),
  fuente: 'PLACSP',
  expediente: 'EXP-2024/001',
  organismo: 'Ministerio de Fomento',
  objeto: 'Servicio de mantenimiento de carreteras',
  cpv: '71315000',
  importe_licitacion: 1_500_000,
  importe_adjudicacion: 1_200_000,
  adjudicatario: 'Empresa Histórica SA',
  fecha_publicacion: '2024-03-15',
  fecha_adjudicacion: null,
  fecha_inicio: null,
  fecha_fin: '2024-04-15', // fecha_limite — deadline, NOT award
  url: 'https://contrataciondelestado.es/ejemplo',
  duracion: null,
  estimation_status: 'not_estimable',
  estimated_end_date: null,
  confidence: null,
  basis: null,
  evidencia: { campo_fuente: 'fecha_limite', url: 'https://contrataciondelestado.es/ejemplo' },
  es_sintetico: true,
};

/** PLACE: subset of nacional/calidad where archivo_origen LIKE %PLACE% */
export const FIXTURE_PLACE_DEADLINE: RadarRecord = {
  id: fixtureId('PLACE', 1),
  fuente: 'PLACE',
  expediente: 'EXP-2024-PLACE-001',
  organismo: 'Ministerio de Agricultura',
  objeto: 'Suministro de material de laboratorio',
  cpv: '33600000',
  importe_licitacion: 900_000,
  importe_adjudicacion: 750_000,
  adjudicatario: 'Laboratorio Agrícola SL',
  fecha_publicacion: '2024-02-10',
  fecha_adjudicacion: null,
  fecha_inicio: null,
  fecha_fin: '2024-03-10', // fecha_limite — deadline, NOT award
  url: 'https://contrataciondelestado.es/ejemplo-place',
  duracion: null,
  estimation_status: 'not_estimable',
  estimated_end_date: null,
  confidence: null,
  basis: null,
  evidencia: { campo_fuente: 'fecha_limite', url: 'https://contrataciondelestado.es/ejemplo-place' },
  es_sintetico: true,
};

/**
 * TED: fecha_fin = DT_AWARD (adjudication), NOT execution start.
 * No fecha_inicio in the unified view, so this is an award-proxy scenario.
 */
export const FIXTURE_TED_AWARD: RadarRecord = {
  id: fixtureId('TED', 1),
  lote: 'LOTE-1',
  version: 'v1',
  fuente: 'TED',
  expediente: '2024/S 060-158000',
  organismo: 'European Commission DG MOVE',
  objeto: 'Framework contract for transport infrastructure studies',
  cpv: '71311000',
  importe_licitacion: 3_000_000,
  importe_adjudicacion: 2_500_000,
  adjudicatario: 'EuroConsult GmbH',
  fecha_publicacion: '2024-03-20', // DT_DISPATCH — publication, NOT start
  fecha_adjudicacion: '2024-06-15', // DT_AWARD
  fecha_inicio: null, // NOT inferred from DT_DISPATCH
  fecha_fin: '2024-06-15', // DT_AWARD — adjudication date
  url: null, // TED doesn't expose URL in unified view
  duracion: { valor: 24, unidad: 'MON' },
  estimation_status: 'award_proxy_scenario',
  estimated_end_date: '2026-06-15', // award + 24 MON
  confidence: null, // ALWAYS null
  basis: 'explicit_award_proxy',
  evidencia: { campo_fuente: 'DT_AWARD', observed_at: '2024-06-15' },
  es_sintetico: true,
};

/** ANDALUCIA: fecha_fin = fecha_limite_presentacion, NOT award */
export const FIXTURE_ANDALUCIA_DEADLINE: RadarRecord = {
  id: fixtureId('ANDALUCIA', 1),
  fuente: 'ANDALUCIA',
  expediente: 'EXP-2024-AND-001',
  organismo: 'Junta de Andalucía - Consejería de Salud',
  objeto: 'Suministro de material sanitario',
  cpv: '33144000',
  importe_licitacion: 800_000,
  importe_adjudicacion: null,
  adjudicatario: null, // Andalucía doesn't always have adjudicatario
  fecha_publicacion: '2024-02-01',
  fecha_adjudicacion: null,
  fecha_inicio: null,
  fecha_fin: '2024-03-01', // fecha_limite_presentacion — deadline
  url: 'https://www.juntadeandalucia.es/ejemplo',
  duracion: null,
  estimation_status: 'not_estimable',
  estimated_end_date: null,
  confidence: null,
  basis: null,
  evidencia: { campo_fuente: 'fecha_limite_presentacion', url: 'https://www.juntadeandalucia.es/ejemplo' },
  es_sintetico: true,
};

/** GALICIA: no fecha_fin — source has no end date column */
export const FIXTURE_GALICIA_NO_DATE: RadarRecord = {
  id: fixtureId('GALICIA', 1),
  fuente: 'GALICIA',
  expediente: 'EXP-2024-GAL-001',
  organismo: 'Xunta de Galicia',
  objeto: 'Servicio de limpieza en edificios públicos',
  cpv: null, // Galicia doesn't provide CPV
  importe_licitacion: 250_000,
  importe_adjudicacion: null, // not available
  adjudicatario: 'Limpiezas Galicia SL',
  fecha_publicacion: '2024-01-15',
  fecha_adjudicacion: null,
  fecha_inicio: null,
  fecha_fin: null, // Galicia has no fecha_fin
  url: null,
  duracion: null,
  estimation_status: 'not_estimable',
  estimated_end_date: null,
  confidence: null,
  basis: null,
  evidencia: { campo_fuente: 'N/A (source lacks fecha_fin column)' },
  es_sintetico: true,
};

/** MADRID: no fecha_fin — comunidad_madrid doesn't have end date */
export const FIXTURE_MADRID_NO_DATE: RadarRecord = {
  id: fixtureId('MADRID', 1),
  fuente: 'MADRID',
  expediente: 'EXP-2024-MAD-001',
  organismo: 'Comunidad de Madrid',
  objeto: 'Conservación de parques y jardines',
  cpv: null,
  importe_licitacion: 1_000_000,
  importe_adjudicacion: 900_000,
  adjudicatario: 'Jardines Madrid SA',
  fecha_publicacion: '2024-04-01',
  fecha_adjudicacion: null,
  fecha_inicio: null,
  fecha_fin: null, // Madrid has no fecha_fin
  url: null,
  duracion: null,
  estimation_status: 'not_estimable',
  estimated_end_date: null,
  confidence: null,
  basis: null,
  evidencia: { campo_fuente: 'N/A (source lacks fecha_fin column)' },
  es_sintetico: true,
};

/**
 * CATALUNYA: fecha_fin = adjudication publication date.
 * No fecha_inicio in the unified view, so this is an award-proxy scenario.
 */
export const FIXTURE_CATALUNYA_ADJUDICACIO: RadarRecord = {
  id: fixtureId('CATALUNYA', 1),
  lote: 'LOT-2024-A',
  fuente: 'CATALUNYA',
  expediente: 'EXP-2024-CAT-001',
  organismo: 'Generalitat de Catalunya',
  objeto: 'Servei de transport sanitari',
  cpv: '60112000',
  importe_licitacion: 5_000_000,
  importe_adjudicacion: 4_200_000,
  adjudicatario: 'Transport Sanitari de Catalunya',
  fecha_publicacion: '2024-02-10',
  fecha_adjudicacion: '2024-05-20', // DATA_PUBLICACIO_ADJUDICACIO
  fecha_inicio: null,
  fecha_fin: '2024-05-20', // adjudication publication
  url: 'https://contractaciopublica.gencat.cat/ejemplo',
  duracion: { valor: 36, unidad: 'MON' },
  estimation_status: 'award_proxy_scenario',
  estimated_end_date: '2027-05-20', // award + 36 MON
  confidence: null,
  basis: 'explicit_award_proxy',
  evidencia: { campo_fuente: 'DATA_PUBLICACIO_ADJUDICACIO', url: 'https://contractaciopublica.gencat.cat/ejemplo' },
  es_sintetico: true,
};

/**
 * VALENCIA: fecha_fin = formalization date.
 * No fecha_inicio in the unified view, so this is an award-proxy scenario.
 */
export const FIXTURE_VALENCIA_FORMALITZACIO: RadarRecord = {
  id: fixtureId('VALENCIA', 1),
  fuente: 'VALENCIA',
  expediente: 'EXP-2024-VLC-001',
  organismo: 'Generalitat Valenciana',
  objeto: 'Mantenimiento de infraestructuras sanitarias',
  cpv: '50117000',
  importe_licitacion: 2_000_000,
  importe_adjudicacion: 1_800_000,
  adjudicatario: 'Mantenimiento VLC SA',
  fecha_publicacion: '2024-03-01',
  fecha_adjudicacion: null,
  fecha_inicio: null,
  fecha_fin: '2024-06-15', // FECHA_FORMALIZACION
  url: 'https://gva.es/licitaciones/ejemplo',
  duracion: { valor: 12, unidad: 'MON' },
  estimation_status: 'award_proxy_scenario',
  estimated_end_date: '2025-06-15', // formalization + 12 MON
  confidence: null,
  basis: 'explicit_award_proxy',
  evidencia: { campo_fuente: 'FECHA_FORMALIZACION', url: 'https://gva.es/licitaciones/ejemplo' },
  es_sintetico: true,
};

/** EUSKADI: mixed fecha_fin (presentation deadline in this case) */
export const FIXTURE_EUSKADI_MIXED: RadarRecord = {
  id: fixtureId('EUSKADI', 1),
  fuente: 'EUSKADI',
  expediente: 'EXP-2024-EUS-001',
  organismo: 'Gobierno Vasco',
  objeto: 'Servicio de consultoría tecnológica',
  cpv: '72000000',
  importe_licitacion: 500_000,
  importe_adjudicacion: 450_000,
  adjudicatario: 'TechEuskadi SL',
  fecha_publicacion: '2024-02-20',
  fecha_adjudicacion: null,
  fecha_inicio: null,
  fecha_fin: '2024-03-20', // fecha_limite_presentacion — deadline
  url: 'https://euskadi.eus/licitaciones/ejemplo',
  duracion: null,
  estimation_status: 'not_estimable',
  estimated_end_date: null,
  confidence: null,
  basis: null,
  evidencia: { campo_fuente: 'fecha_límite_de_presentación', url: 'https://euskadi.eus/licitaciones/ejemplo' },
  es_sintetico: true,
};

// ─── Negative fixtures ───────────────────────────────────────────────

/** NEGATIVE: duration with invalid unit — must fail validation */
export const FIXTURE_INVALID_DURATION: RadarRecord = {
  id: fixtureId('PLACSP', 2),
  fuente: 'PLACSP',
  expediente: 'EXP-2024/002',
  organismo: 'Organismo Test',
  objeto: 'Servicio de test',
  cpv: null,
  importe_licitacion: 100_000,
  importe_adjudicacion: null,
  adjudicatario: null,
  fecha_publicacion: '2024-01-01',
  fecha_adjudicacion: null,
  fecha_inicio: null,
  fecha_fin: null,
  url: null,
  duracion: { valor: 6, unidad: 'WEEK' as any }, // INVALID unit
  estimation_status: 'not_estimable',
  estimated_end_date: null,
  confidence: null,
  basis: null,
  evidencia: { campo_fuente: 'test' },
  es_sintetico: true,
};

/** NEGATIVE: confidence not null — must fail validation */
export const FIXTURE_INVALID_CONFIDENCE: RadarRecord = {
  id: fixtureId('PLACSP', 3),
  fuente: 'PLACSP',
  expediente: 'EXP-2024/003',
  organismo: 'Organismo Test',
  objeto: 'Servicio de test',
  cpv: null,
  importe_licitacion: 100_000,
  importe_adjudicacion: null,
  adjudicatario: null,
  fecha_publicacion: '2024-01-01',
  fecha_adjudicacion: null,
  fecha_inicio: null,
  fecha_fin: null,
  url: null,
  duracion: null,
  estimation_status: 'not_estimable',
  estimated_end_date: null,
  confidence: 'high' as any, // INVALID — must be null
  basis: null,
  evidencia: { campo_fuente: 'test' },
  es_sintetico: true,
};

/** NEGATIVE: not_estimable with estimated_end_date set — inconsistent */
export const FIXTURE_INCONSISTENT_ESTIMATION: RadarRecord = {
  id: fixtureId('PLACSP', 4),
  fuente: 'PLACSP',
  expediente: 'EXP-2024/004',
  organismo: 'Organismo Test',
  objeto: 'Servicio de test inconsistente',
  cpv: null,
  importe_licitacion: 100_000,
  importe_adjudicacion: null,
  adjudicatario: null,
  fecha_publicacion: '2024-01-01',
  fecha_adjudicacion: null,
  fecha_inicio: null,
  fecha_fin: null,
  url: null,
  duracion: null,
  estimation_status: 'not_estimable',
  estimated_end_date: '2025-01-01', // INCONSISTENT: not_estimable + estimated date
  confidence: null,
  basis: null,
  evidencia: { campo_fuente: 'test' },
  es_sintetico: true,
};

/** NEGATIVE: award_proxy_scenario with no award anchor — inconsistent */
export const FIXTURE_NO_AWARD_ANCHOR: RadarRecord = {
  id: fixtureId('PLACSP', 5),
  fuente: 'PLACSP',
  expediente: 'EXP-2024/005',
  organismo: 'Organismo Test',
  objeto: 'Servicio sin ancla de adjudicación',
  cpv: null,
  importe_licitacion: 100_000,
  importe_adjudicacion: null,
  adjudicatario: null,
  fecha_publicacion: '2024-01-01',
  fecha_adjudicacion: null,
  fecha_inicio: null,
  fecha_fin: null,
  url: null,
  duracion: { valor: 12, unidad: 'MON' },
  estimation_status: 'award_proxy_scenario', // INVALID: no award anchor
  estimated_end_date: '2025-01-01',
  confidence: null,
  basis: 'explicit_award_proxy',
  evidencia: { campo_fuente: 'test' },
  es_sintetico: true,
};

// ─── All fixtures (for batch testing) ────────────────────────────────

export const ALL_FIXTURES: RadarRecord[] = [
  FIXTURE_PLACSP_DEADLINE,
  FIXTURE_PLACE_DEADLINE,
  FIXTURE_TED_AWARD,
  FIXTURE_ANDALUCIA_DEADLINE,
  FIXTURE_GALICIA_NO_DATE,
  FIXTURE_MADRID_NO_DATE,
  FIXTURE_CATALUNYA_ADJUDICACIO,
  FIXTURE_VALENCIA_FORMALITZACIO,
  FIXTURE_EUSKADI_MIXED,
  // Negatives:
  FIXTURE_INVALID_DURATION,
  FIXTURE_INVALID_CONFIDENCE,
  FIXTURE_INCONSISTENT_ESTIMATION,
  FIXTURE_NO_AWARD_ANCHOR,
];
