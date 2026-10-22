import type { RecordExclusionRegistry } from './market-intelligence.js';

/**
 * Evidence-backed record exclusions for the construction dataset (v1).
 * Each entry removes one source record before aggregation and carries the
 * editorial decision trail: what the syndication feed declared, what the
 * expedition file actually shows, and where the evidence lives.
 */
export const constructionRecordExclusions: RecordExclusionRegistry = {
  schema: 'elicita.record-exclusion-registry/v1',
  version: 1,
  dataset: 'construction',
  entries: [
    {
      record_id: 'https://contrataciondelestado.es/sindicacion/PlataformasAgregadasSinMenores/15091104',
      reason_code: 'source_amount_error',
      reason_label: 'Importe de fuente erróneo verificado contra el expediente: la rehabilitación en c/ Kanpandegi 2 (Donostia) vale 2.518.819 €, no los 2.357.531.666 € sindicados',
      declared_amount_eur: 2357531666.05,
      verified_amount_eur: 2518819,
      evidence_url: 'https://donlicitacion.es/expediente/ejecucion-de-la-obra-de-rehabilitacion-de-edificio-para-equipamiento-para-uso-de-4b7d2035073995e8',
      decision_date: '2026-09-16',
      decision_source: 'faro-visual-front F3b · gate 4 opción A',
    },
  ],
};
