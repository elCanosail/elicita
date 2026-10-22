import type { IdentityRegistry } from './open-data-generator.js';
import type { GroupRecord } from './open-data-generator.js';

/**
 * Grupos empresariales curados. Cada registro asigna un NIF observado en el
 * corpus a un grupo con membresía pública, estable y verificable por URL.
 * Política: solo grupos con al menos dos sociedades miembros presentes en el
 * corpus y cuya pertenencia es pública e incontestada durante toda la ventana
 * 2022-2026. Se excluyen deliberadamente: OHL/Ingesan (Ingesan vendida a VINCI
 * en 2016; la denominación persiste pero la propiedad no coincide con el nombre),
 * ASISA/Hospitales Pascual (pertenencia no suficientemente cierta para el gate)
 * y candidatos de miembro único (Ferrovial, Telefónica, Urbaser, PreZero,
 * Iberdrola), que no aportan rollup.
 */
export const CURATED_GROUPS: readonly GroupRecord[] = [
  { group_id: 'airbus', group_name: 'Grupo Airbus', nif: 'A28006104', company_name: 'Airbus Defence and Space SA', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.airbus.com/en/company', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'airbus', group_name: 'Grupo Airbus', nif: 'A78648110', company_name: 'Airbus Helicopters España', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.airbus.com/en/company', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'indra', group_name: 'Grupo Indra', nif: 'A28599033', company_name: 'Indra Sistemas, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.indracompany.com', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'indra', group_name: 'Grupo Indra', nif: 'B88018098', company_name: 'Indra Soluciones Tecnologías de la Información', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.indracompany.com', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'fcc', group_name: 'Grupo FCC', nif: 'A28854727', company_name: 'FCC Construcción, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.fcc.es', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'fcc', group_name: 'Grupo FCC', nif: 'A28541639', company_name: 'FCC Medio Ambiente, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.fcc.es', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'fcc', group_name: 'Grupo FCC', nif: 'A26019992', company_name: 'FCC Aqualia, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.fcc.es', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'acciona', group_name: 'Grupo Acciona', nif: 'A81638108', company_name: 'Acciona Construcción, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.acciona.com', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'acciona', group_name: 'Grupo Acciona', nif: 'A95113361', company_name: 'Acciona Agua, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.acciona.com', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'acciona', group_name: 'Grupo Acciona', nif: 'A08175994', company_name: 'Acciona Facility Services, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.acciona.com', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'sacyr', group_name: 'Grupo Sacyr', nif: 'A78366382', company_name: 'Sacyr Construcción, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.sacyr.com', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'sacyr', group_name: 'Grupo Sacyr', nif: 'B06285092', company_name: 'Sacyr Agua, S.L.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.sacyr.com', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'sacyr', group_name: 'Grupo Sacyr', nif: 'A83709873', company_name: 'Sacyr Facilities, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.sacyr.com', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'acs', group_name: 'Grupo ACS', nif: 'A15139314', company_name: 'Dragados, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.grupoacs.com', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'acs', group_name: 'Grupo ACS', nif: 'A80364243', company_name: 'Clece, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.clece.es', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'roche', group_name: 'Grupo Roche', nif: 'A08023145', company_name: 'Roche Farma, S.A.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.roche.es', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
  { group_id: 'roche', group_name: 'Grupo Roche', nif: 'B61503355', company_name: 'Roche Diagnostics, S.L.', valid_from: '2000-01-01', valid_to: null, evidence_url: 'https://www.roche.es', evidence_type: 'corporate_website', reviewed_at: '2026-09-25', registry_version: '1.0.0' },
];

/**
 * Fusiona los grupos curados en un registro derivado observado (que no
 * contiene grupos). Falla si un NIF curado colisiona con un grupo ya presente
 * — atribución ambigua — o si la versión del registro no coincide.
 */
export function mergeCuratedGroups(registry: IdentityRegistry): IdentityRegistry {
  if (registry.groups.length > 0) throw new Error('mergeCuratedGroups expects a derived registry without groups');
  const seen = new Set<string>();
  for (const group of CURATED_GROUPS) {
    if (group.registry_version !== registry.version) throw new Error(`curated group ${group.nif} registry_version mismatch`);
    if (seen.has(group.nif)) throw new Error(`curated group NIF duplicated: ${group.nif}`);
    seen.add(group.nif);
  }
  return { ...registry, groups: [...CURATED_GROUPS] };
}
