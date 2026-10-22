/**
 * Correcciones de importes de fuente — espejo local de calidad/correcciones.py
 * (upstream: BquantFinance/licitaciones-espana, issue #22).
 *
 * Filosofía compartida con el upstream: los importes publicados se enseñan tal
 * cual (que se publicara mal también es dato para la auditoría); los agregados
 * (sumas, rankings, cuotas) usan el corregido.
 *
 * Reglas (constantes idénticas al upstream):
 *  - registro:      error verificado a mano con evidencia (errores_fuente.csv);
 *                   solo cambia las versiones que aún publican el valor erróneo.
 *                   Manda sobre la escala, como en correcciones.py.
 *  - escala_x100/x1000: adjudicación de ≥100× presupuesto que dividida entre 100
 *                   o 1.000 vuelve a su orden (coma decimal perdida en origen):
 *                   mismas cifras que el presupuesto (tolerancia 0,005 €, desde
 *                   1.000 €) o entre el 50 % y el 105 % de él (desde 10.000 €).
 *                   Solo el par sin IVA.
 *  - inverosimil:   ≥100× sin corrección fiable → no suma.
 *  - no_comparable: presupuesto < 1.000 € con salto ≥100× (precio unitario o
 *                   simbólico, a menudo 1 €) → la adjudicación se mantiene.
 */

export const SALTO_ESCALA = 100;
export const PRESUPUESTO_COMPARABLE = 1_000;
export const PRESUPUESTO_BANDA = 10_000;
export const BANDA_ADJ_LIC = [0.5, 1.05] as const;
export const EXPONENTES = [2, 3] as const;
/** Tolerancia absoluta de "mismas cifras que el presupuesto" (upstream: atol=0.005, rtol=0). */
const TOL_EXACTO = 0.005;

export interface ImporteFuente {
  importeAdjudicacion: number | null;
  presupuesto: number | null;
  /** URL de sindicación/anuncio, para casar el registro de errores verificados. */
  urlPub?: string | null;
}

export type MotivoCorreccion =
  | 'registro'
  | 'escala_x100'
  | 'escala_x1000'
  | 'inverosimil'
  | 'no_comparable';

export interface ImporteCorregido {
  /** Importe de adjudicación a sumar; null si no es fiable y no hay corrección. */
  valor: number | null;
  motivo: MotivoCorreccion | null;
}

/** Errores de fuente verificados a mano (upstream: calidad/errores_fuente.csv, issue #22).
 *  Aplica solo si el registro aún publica el valor erróneo. Cada entrada casa por
 *  fragmento de URL: el dataset guarda url_pub de la plataforma de ORIGEN
 *  (Euskadi expjaso522774 para URDINBERRI), no de sindicación PLACSP, y el id
 *  completo upstream es la URL de sindicación. Se admiten ambos. */
const REGISTRO: ReadonlyArray<{
  idFragmentes: readonly string[];
  valorPublicado: number;
  valorProbable: number;
  referencia: string;
}> = [
  {
    idFragmentes: ['expjaso522774', '/PlataformasAgregadasSinMenores/15091104'],
    valorPublicado: 2357531666,
    valorProbable: 2357531.666,
    referencia: 'https://github.com/BquantFinance/licitaciones-espana/issues/22',
  },
];

function escalaValida(
  adj: number,
  pres: number,
): { valor: number; motivo: 'escala_x100' | 'escala_x1000' } | null {
  for (const exp of EXPONENTES) {
    const escalado = adj / 10 ** exp;
    const q = escalado / pres;
    const exacto = Math.abs(escalado - pres) <= TOL_EXACTO && pres >= PRESUPUESTO_COMPARABLE;
    const banda = q >= BANDA_ADJ_LIC[0] && q <= BANDA_ADJ_LIC[1] && pres >= PRESUPUESTO_BANDA;
    if (exacto || banda) {
      return { valor: Math.round(escalado * 100) / 100, motivo: exp === 2 ? 'escala_x100' : 'escala_x1000' };
    }
  }
  return null;
}

export function corregirImporteAdjudicacion(src: ImporteFuente): ImporteCorregido {
  const adj = src.importeAdjudicacion;
  if (adj == null || !Number.isFinite(adj) || adj <= 0) {
    // Sin adjudicación publicada no hay corrección de escala que aplicar.
    return { valor: null, motivo: null };
  }

  const pres = src.presupuesto;
  const haySalto = pres != null && Number.isFinite(pres) && pres > 0 && adj >= SALTO_ESCALA * pres;

  let resultado: ImporteCorregido | null = null;
  if (haySalto && pres != null) {
    const escala = escalaValida(adj, pres);
    if (escala) {
      resultado = escala;
    } else if (pres < PRESUPUESTO_COMPARABLE) {
      resultado = { valor: adj, motivo: 'no_comparable' };
    } else {
      resultado = { valor: null, motivo: 'inverosimil' };
    }
  }

  // El registro de errores verificados manda sobre la escala (orden de correcciones.py).
  const urlPub = src.urlPub;
  for (const reg of REGISTRO) {
    if (adj === reg.valorPublicado && urlPub != null && reg.idFragmentes.some((f) => urlPub.includes(f))) {
      return { valor: reg.valorProbable, motivo: 'registro' };
    }
  }

  return resultado ?? { valor: adj, motivo: null };
}
