/**
 * Contrato del ticker público (/api/public/ticker): campo por campo.
 *
 * Nota de contrato (2026-10-05): `fuente` se retira — el SELECT traía
 * `id_plataforma` (ID numérico interno de la plataforma de origen) pero el
 * mapeo leía `r.fuente`, columna que no existe en `calidad`, así que el API
 * devolvía siempre "". Ticker.astro no renderiza ese campo.
 */

export interface TickerItem {
  expediente: string;
  organo: string;
  adjudicatario: string;
  importe: number;
  fecha_publicacion: string | Date | null;
}

export function mapTickerRow(r: any): TickerItem {
  return {
    expediente: r.expediente ?? '',
    organo: r.organo_contratante ?? '',
    adjudicatario: r.adjudicatario ?? '',
    importe: typeof r.importe_adjudicacion === 'bigint' ? Number(r.importe_adjudicacion) : (r.importe_adjudicacion ?? 0),
    fecha_publicacion: r.fecha_publicacion ?? null,
  };
}
