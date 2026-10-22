/**
 * Radar synthetic fixtures (T6 — injected data source).
 *
 * Re-exports the existing fixtures from samples.ts but also adds
 * a few extra records that have valid estimation scenarios (start+duration,
 * award+duration) so the queryable dataset has some estimable records
 * for when lineage is confirmed.
 *
 * ⚠️  SYNTHETIC DATA — NOT real opportunities.
 *
 * Source: web/src/lib/radar/fixtures.ts
 */

import type { RadarRecord } from './inventory';
import {
  FIXTURE_PLACSP_DEADLINE,
  FIXTURE_PLACE_DEADLINE,
  FIXTURE_TED_AWARD,
  FIXTURE_ANDALUCIA_DEADLINE,
  FIXTURE_GALICIA_NO_DATE,
  FIXTURE_MADRID_NO_DATE,
  FIXTURE_CATALUNYA_ADJUDICACIO,
  FIXTURE_VALENCIA_FORMALITZACIO,
  FIXTURE_EUSKADI_MIXED,
  FIXTURE_INVALID_DURATION,
  FIXTURE_INVALID_CONFIDENCE,
  FIXTURE_INCONSISTENT_ESTIMATION,
  FIXTURE_NO_AWARD_ANCHOR,
  ALL_FIXTURES,
} from './samples';

// ─── Extra estimable fixtures ────────────────────────────────────────

/** PLACSP with explicit start + duration → contractual_scenario */
export const FIXTURE_PLACSP_ESTIMABLE: RadarRecord = {
  id: 'SYNTH-PLACSP-EST-001',
  fuente: 'PLACSP',
  expediente: 'EXP-2024/010',
  organismo: 'Ministerio de Sanidad',
  objeto: 'Servicio de mantenimiento de sistemas informáticos',
  cpv: '62021000',
  importe_licitacion: 2_000_000,
  importe_adjudicacion: 1_800_000,
  adjudicatario: 'TechServicios SA',
  fecha_publicacion: '2024-01-15',
  fecha_adjudicacion: null,
  fecha_inicio: '2024-03-01', // explicit start
  fecha_fin: '2025-02-28', // deadline (not used for estimation)
  url: 'https://contrataciondelestado.es/ejemplo-sanidad',
  duracion: { valor: 12, unidad: 'MON' },
  estimation_status: 'contractual_scenario',
  estimated_end_date: '2025-03-01',
  confidence: null,
  basis: 'explicit_start',
  evidencia: { campo_fuente: 'fecha_limite', url: 'https://contrataciondelestado.es/ejemplo-sanidad' },
  es_sintetico: true,
};

/** TED with award + duration → award_proxy_scenario */
export const FIXTURE_TED_ESTIMABLE: RadarRecord = {
  id: 'SYNTH-TED-EST-001',
  lote: 'LOTE-2',
  fuente: 'TED',
  expediente: '2024/S 090-280000',
  organismo: 'European Commission DG GROW',
  objeto: 'Consultancy services for digital transformation',
  cpv: '72200000',
  importe_licitacion: 5_000_000,
  importe_adjudicacion: 4_500_000,
  adjudicatario: 'Digital Solutions EU BV',
  fecha_publicacion: '2024-05-01',
  fecha_adjudicacion: '2024-07-15',
  fecha_inicio: null,
  fecha_fin: '2024-07-15', // DT_AWARD
  url: null,
  duracion: { valor: 36, unidad: 'MON' },
  estimation_status: 'award_proxy_scenario',
  estimated_end_date: '2027-07-15',
  confidence: null,
  basis: 'explicit_award_proxy',
  evidencia: { campo_fuente: 'DT_AWARD', observed_at: '2024-07-15' },
  es_sintetico: true,
};

/** CATALUNYA with start + duration → contractual_scenario */
export const FIXTURE_CATALUNYA_ESTIMABLE: RadarRecord = {
  id: 'SYNTH-CAT-EST-001',
  fuente: 'CATALUNYA',
  expediente: 'EXP-2024-CAT-010',
  organismo: 'Ajuntament de Barcelona',
  objeto: 'Servei de neteja viària',
  cpv: '90000000',
  importe_licitacion: 1_200_000,
  importe_adjudicacion: 1_000_000,
  adjudicatario: 'Neteja Barcelona SA',
  fecha_publicacion: '2024-04-01',
  fecha_adjudicacion: '2024-06-01',
  fecha_inicio: '2024-07-01',
  fecha_fin: '2024-06-01', // DATA_PUB_ADJUDICACIO
  url: 'https://contractaciopublica.gencat.cat/ejemplo-barcelona',
  duracion: { valor: 24, unidad: 'MON' },
  estimation_status: 'contractual_scenario',
  estimated_end_date: '2026-07-01',
  confidence: null,
  basis: 'explicit_start',
  evidencia: { campo_fuente: 'DATA_PUB_ADJUDICACIO', url: 'https://contractaciopublica.gencat.cat/ejemplo-barcelona' },
  es_sintetico: true,
};

/** VALENCIA with start + duration → contractual_scenario */
export const FIXTURE_VALENCIA_ESTIMABLE: RadarRecord = {
  id: 'SYNTH-VLC-EST-001',
  fuente: 'VALENCIA',
  expediente: 'EXP-2024-VLC-010',
  organismo: 'Conselleria de Sanidad Valencia',
  objeto: 'Mantenimiento de equipos médicos',
  cpv: '33143000',
  importe_licitacion: 900_000,
  importe_adjudicacion: 800_000,
  adjudicatario: 'MedValencia SL',
  fecha_publicacion: '2024-05-15',
  fecha_adjudicacion: '2024-07-01',
  fecha_inicio: '2024-08-01',
  fecha_fin: '2024-07-01', // FECHA_FORMALIZACION
  url: 'https://gva.es/licitaciones/ejemplo-salud',
  duracion: { valor: 24, unidad: 'MON' },
  estimation_status: 'contractual_scenario',
  estimated_end_date: '2026-08-01',
  confidence: null,
  basis: 'explicit_start',
  evidencia: { campo_fuente: 'FECHA_FORMALIZACION', url: 'https://gva.es/licitaciones/ejemplo-salud' },
  es_sintetico: true,
};

// ─── All fixtures (for batch testing) ────────────────────────────────

/**
 * All fixtures including the extra estimable ones.
 * This is the full synthetic dataset used by the injection adapter.
 */
export const RADAR_FIXTURES: RadarRecord[] = [
  ...ALL_FIXTURES,
  FIXTURE_PLACSP_ESTIMABLE,
  FIXTURE_TED_ESTIMABLE,
  FIXTURE_CATALUNYA_ESTIMABLE,
  FIXTURE_VALENCIA_ESTIMABLE,
];