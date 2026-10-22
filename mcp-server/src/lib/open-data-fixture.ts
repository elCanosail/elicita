import type { IdentityRegistry, SourceContractRow, TechnologyTaxonomy } from './open-data-generator.js';

/**
 * Non-production fixture. It deliberately uses generic entities and leaves
 * corporate ownership unresolved unless an evidence-backed registry says so.
 */
export const technologyFixtureRows: readonly SourceContractRow[] = [
  {
    analytic_id: 'fixture-001', award_date: '2024-01-15', cpv: '72262000-9',
    supplier_nif: 'B12345674', supplier_name: 'Proveedor Tecnológico, S.A.',
    buyer_key: 'buyer-demo-1', buyer_name: 'Organismo Demostración Uno',
    observed_amount_eur: 120000, ute: false,
  },
  {
    analytic_id: 'fixture-002', award_date: '2024-02-10', cpv: '32420000-3',
    supplier_nif: 'B76543214', supplier_name: 'Redes Públicas, S.L.',
    buyer_key: 'buyer-demo-1', buyer_name: 'Organismo Demostración Uno',
    observed_amount_eur: 80000, ute: false,
  },
  {
    analytic_id: 'fixture-003', award_date: '2025-03-20', cpv: '72262000-9',
    supplier_nif: null, supplier_name: 'UTE de ejemplo',
    buyer_key: 'buyer-demo-2', buyer_name: 'Organismo Demostración Dos',
    observed_amount_eur: 50000, ute: true,
  },
  {
    analytic_id: 'fixture-004', award_date: '2025-04-01', cpv: null,
    supplier_nif: 'B12345674', supplier_name: 'Proveedor Tecnológico, S.A.',
    buyer_key: 'buyer-demo-2', buyer_name: 'Organismo Demostración Dos',
    observed_amount_eur: 20000, ute: false,
  },
  {
    analytic_id: 'fixture-005', award_date: '2025-04-03', cpv: '99999999-9',
    supplier_nif: 'B12345674', supplier_name: 'Proveedor Tecnológico, S.A.',
    buyer_key: 'buyer-demo-2', buyer_name: 'Organismo Demostración Dos',
    observed_amount_eur: 10000, ute: false,
  },
];

export const technologyTaxonomy: TechnologyTaxonomy = {
  schema: 'elicita.cpv-taxonomy/v1',
  version: 'fixture-1.0.0',
  dataset: 'technology',
  rules: [
    {
      cpv: '72262000', label: 'Software', subsector: 'software_licences', status: 'include',
      reason: 'Software development services', decision_date: '2026-09-14', decision_source: 'P0 fixture methodology',
    },
    {
      cpv: '32420000', label: 'Network equipment', subsector: 'networks_telecommunications', status: 'include',
      reason: 'Network equipment', decision_date: '2026-09-14', decision_source: 'P0 fixture methodology',
    },
    {
      cpv: '99999999', label: 'Out of scope fixture code', subsector: 'unknown', status: 'exclude',
      reason: 'Explicit fixture exclusion', decision_date: '2026-09-14', decision_source: 'P0 fixture methodology',
    },
  ],
};

/** Production candidate taxonomy. It deliberately matches the historical IT
 * article's two explicit CPV divisions. Broader equipment and telecom
 * divisions require a separate methodology revision. */
export const technologyProductionTaxonomy: TechnologyTaxonomy = {
  schema: 'elicita.cpv-taxonomy/v1',
  version: '1.0.0',
  dataset: 'technology',
  rules: [
    {
      cpv: '48', label: 'Paquetes de software y sistemas de información', subsector: 'software_licences', status: 'include',
      reason: 'División CPV 48 incluida explícitamente en el análisis tecnológico histórico.', decision_date: '2026-09-14', decision_source: 'open-data-market-intelligence-v1 + oligopolio-it-publico',
    },
    {
      cpv: '72', label: 'Servicios TI: consultoría, desarrollo, Internet y apoyo', subsector: 'it_services', status: 'include',
      reason: 'División CPV 72 incluida explícitamente en el análisis tecnológico histórico.', decision_date: '2026-09-14', decision_source: 'open-data-market-intelligence-v1 + oligopolio-it-publico',
    },
  ],
};

/** Production candidate taxonomy for the construction ficha (F3b). The full
 * CPV division 45 — works, installations and machinery rental with operator —
 * declared as one explicit rule; narrower splits require a methodology revision. */
export const constructionProductionTaxonomy: TechnologyTaxonomy = {
  schema: 'elicita.cpv-taxonomy/v1',
  version: '1.0.0',
  dataset: 'construction',
  rules: [
    {
      cpv: '45', label: 'Trabajos de construcción', subsector: 'construction_works', status: 'include',
      reason: 'División CPV 45 completa incluida explícitamente para la ficha de construcción (obra, instalaciones y alquiler de maquinaria con operador).', decision_date: '2026-09-16', decision_source: 'faro-visual-front F3b',
    },
  ],
};

export const saludProductionTaxonomy: TechnologyTaxonomy = {
  schema: 'elicita.cpv-taxonomy/v1',
  version: '1.0.0',
  dataset: 'salud',
  rules: [
    {
      cpv: '33', label: 'Equipamiento médico', subsector: 'medical_equipment', status: 'include',
      reason: 'División CPV 33 propuesta como mitad material del sector salud (aparatos médicos, oftalmológicos y ortopédicos, incluidos mobiliario y material sanitario).', decision_date: '2026-09-19', decision_source: 'propuesta elcano para gate 4 — sector sin ratificar aún por el operador (faro-visual-front F4)',
    },
    {
      cpv: '85', label: 'Servicios de salud y trabajo social', subsector: 'health_services', status: 'include',
      reason: 'División CPV 85 propuesta como mitad servicios del sector salud (sanidad pública, gestión de hospitales, servicios de salud y trabajo social).', decision_date: '2026-09-19', decision_source: 'propuesta elcano para gate 4 — sector sin ratificar aún por el operador (faro-visual-front F4)',
    },
  ],
};

export const energiaProductionTaxonomy: TechnologyTaxonomy = {
  schema: 'elicita.cpv-taxonomy/v1',
  version: '1.0.0',
  dataset: 'energia',
  rules: [
    {
      cpv: '31', label: 'Equipamiento eléctrico y de energía', subsector: 'energy_equipment', status: 'include',
      reason: 'División CPV 31 propuesta como mitad material del sector energía (maquinaria y aparatos eléctricos: transformadores, cables, material de distribución, generación e iluminación).', decision_date: '2026-09-24', decision_source: 'propuesta elcano para gate 4 — sector sin ratificar aún por el operador (4º sector tras salud)',
    },
    {
      cpv: '65', label: 'Suministros de energía', subsector: 'energy_supply', status: 'include',
      reason: 'División CPV 65 propuesta como mitad servicios del sector energía (electricidad, gas, calor y vapor para suministro a administraciones).', decision_date: '2026-09-24', decision_source: 'propuesta elcano para gate 4 — sector sin ratificar aún por el operador (4º sector tras salud)',
    },
  ],
};

export const limpiezaProductionTaxonomy: TechnologyTaxonomy = {
  schema: 'elicita.cpv-taxonomy/v1',
  version: '1.0.0',
  dataset: 'limpieza',
  rules: [
    {
      cpv: '905', label: 'Gestión de residuos', subsector: 'waste_management', status: 'include',
      reason: 'Grupo CPV 905 como núcleo material del sector: recogida, transporte, tratamiento y eliminación de residuos (~26,4 G€ en la ventana de cribado 2022-2026, el mayor de la división 90).', decision_date: '2026-09-24', decision_source: 'selección del operador (Chema, 2026-09-24) — 5º sector tras energía',
    },
    {
      cpv: '909', label: 'Limpieza de edificios y urbanidad', subsector: 'cleaning_services', status: 'include',
      reason: 'Grupo CPV 909 como pata servicios del sector (~11,9 G€): limpieza de edificios (9091) y limpieza viaria (9092), el contrato municipal recurrente por excelencia.', decision_date: '2026-09-24', decision_source: 'selección del operador (Chema, 2026-09-24) — 5º sector tras energía',
    },
    {
      cpv: '906', label: 'Descontaminación y medio ambiente', subsector: 'decontamination', status: 'include',
      reason: 'Grupo CPV 906 (~10,8 G€): descontaminación, limpieza del suelo y mantenimiento de espacios naturales (desbroces y márgenes).', decision_date: '2026-09-24', decision_source: 'selección del operador (Chema, 2026-09-24) — 5º sector tras energía',
    },
    {
      cpv: '904', label: 'Saneamiento y depuración de aguas', subsector: 'sewage_treatment', status: 'include',
      reason: 'Grupo CPV 904 (~2,9 G€): explotación y conservación de EDARs y obras de saneamiento menor bajo esta serie del corpus.', decision_date: '2026-09-24', decision_source: 'selección del operador (Chema, 2026-09-24) — 5º sector tras energía',
    },
    {
      cpv: '90', label: 'Otros servicios del entorno', subsector: 'environmental_other', status: 'include',
      reason: 'Regla de cierre de la división 90: códigos genéricos (p. ej. 90000000 analítica de aguas) quedan en el sector con subsector propio; la precedencia de prefijos específicos aplica antes.', decision_date: '2026-09-24', decision_source: 'selección del operador (Chema, 2026-09-24) — 5º sector tras energía',
    },
  ],
};

export const defensaProductionTaxonomy: TechnologyTaxonomy = {
  schema: 'elicita.cpv-taxonomy/v1',
  version: '1.0.0',
  dataset: 'defensa',
  rules: [
    {
      cpv: '356', label: 'Buques y plataformas navales militares', subsector: 'naval_platforms', status: 'include',
      reason: 'Grupo CPV 356 como núcleo naval del sector (~27,2 G€ en el corpus: buques de guerra 3561 en 22,5 G€ y submarinos/plataformas 3563), el mayor bloque de defensa español.', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "a tope") — 6º sector tras limpieza',
    },
    {
      cpv: '353', label: 'Munición, misiles y explosivos militares', subsector: 'munitions_missiles', status: 'include',
      reason: 'Grupo CPV 353 (~18,7 G€: misiles 3532 y municiones 3533), pata balística y misilística del sector.', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "a tope") — 6º sector tras limpieza',
    },
    {
      cpv: '357', label: 'Aeronaves militares y accesorios', subsector: 'military_aircraft', status: 'include',
      reason: 'Grupo CPV 357 (~11,9 G€: aeronaves de combate y transporte 3571, reparación 3572, componentes 3573).', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "a tope") — 6º sector tras limpieza',
    },
    {
      cpv: '354', label: 'Vehículos de combate', subsector: 'combat_vehicles', status: 'include',
      reason: 'Grupo CPV 354 (~6,1 G€: vehículos blindados de combate 3541), pata terrestre del sector.', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "a tope") — 6º sector tras limpieza',
    },
    {
      cpv: '351', label: 'Armamento y explosivos de uso militar', subsector: 'weapons_explosives', status: 'include',
      reason: 'Grupo CPV 351 (~1,3 G€ observado en 3512), armamento ligero y material de fuego.', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "a tope") — 6º sector tras limpieza',
    },
    {
      cpv: '358', label: 'Optrónica, sensores y visión nocturna', subsector: 'sensors_optoelectronics', status: 'include',
      reason: 'Grupo CPV 358 (~1 G€: equipos ópticos y optrónicos militares 3581/3582).', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "a tope") — 6º sector tras limpieza',
    },
    {
      cpv: '35', label: 'Otros equipos de defensa', subsector: 'defense_other', status: 'include',
      reason: 'Regla de cierre de la división 35: la división es de por sí militar (armas, munición, plataformas de combate), sin ramas civiles que excluir; códigos genéricos quedan con subsector propio y la precedencia de prefijos específicos aplica antes.', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "a tope") — 6º sector tras limpieza',
    },
  ],
};

export const transporteProductionTaxonomy: TechnologyTaxonomy = {
  schema: 'elicita.cpv-taxonomy/v1',
  version: '1.0.0',
  dataset: 'transporte',
  rules: [
    {
      cpv: '601', label: 'Transporte terrestre (carretera, urbano, correo y mudanzas)', subsector: 'road_transport', status: 'include',
      reason: 'Grupo CPV 601 como núcleo terrestre del sector (~24,2 G€ en el corpus: transporte por carretera 6011 en 19,8 G€ y urbano 6010 en 4,4 G€; concesiones urbanas con contratos marco de cientos de M€).', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "sigamos con transporte") — 7º sector tras defensa',
    },
    {
      cpv: '602', label: 'Transporte marítimo y fluvial', subsector: 'water_transport', status: 'include',
      reason: 'Grupo CPV 602, pata naval del sector (ferris, cabotaje y fluvial).', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "sigamos con transporte") — 7º sector tras defensa',
    },
    {
      cpv: '603', label: 'Transporte aéreo', subsector: 'air_transport', status: 'include',
      reason: 'Grupo CPV 603, pata aérea del sector.', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "sigamos con transporte") — 7º sector tras defensa',
    },
    {
      cpv: '604', label: 'Transporte por tubería', subsector: 'pipeline_transport', status: 'include',
      reason: 'Grupo CPV 604 (~4,4 G€ observados en 6044), transporte de crudo y derivados por oleoducto/gasoducto.', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "sigamos con transporte") — 7º sector tras defensa',
    },
    {
      cpv: '60', label: 'Otros servicios de transporte', subsector: 'transport_other', status: 'include',
      reason: 'Regla de cierre de la división 60 (~3,1 G€ en códigos genéricos 6000): la división es de por sí servicios de transporte; códigos genéricos quedan con subsector propio y la precedencia de prefijos específicos aplica antes. La división 50 (reparación y mantenimiento) se EXCLUYE del sector: su tabla contiene importes corruptos evidentes (contrato top de 251.520 M€ duplicado — Ayuntamiento de Oviedo → Talleres Riestra, 2020) que contaminan cualquier agregación con ella.', decision_date: '2026-09-25', decision_source: 'ratificación del operador (Chema, 2026-09-25, "sigamos con transporte") — 7º sector tras defensa',
    },
  ],
};

export const technologyIdentityRegistry: IdentityRegistry = {
  schema: 'elicita.identity-registry/v1',
  version: '1.0.0',
  companies: [
    { nif: 'B12345674', company_name: 'Proveedor Tecnológico, S.A.', reviewed_at: '2026-09-14', registry_version: '1.0.0' },
    { nif: 'B76543214', company_name: 'Redes Públicas, S.L.', reviewed_at: '2026-09-14', registry_version: '1.0.0' },
  ],
  groups: [],
  utes: [],
  buyers: [
    { buyer_id: 'buyer-demo-1', buyer_name: 'Organismo Demostración Uno', aliases: ['ORGANISMO DEMO 1'], valid_from: '2020-01-01', valid_to: null, reviewed_at: '2026-09-14', registry_version: '1.0.0' },
    { buyer_id: 'buyer-demo-2', buyer_name: 'Organismo Demostración Dos', aliases: [], valid_from: '2020-01-01', valid_to: null, reviewed_at: '2026-09-14', registry_version: '1.0.0' },
  ],
};
