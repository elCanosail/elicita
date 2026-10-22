/**
 * Estado de ordenación del monitor (extraído verbatim de MonitorTable.astro 05-10-2026).
 * Click en cabecera: misma columna invierte dirección; columna nueva arranca
 * descendente en fecha/importe, ascendente en el resto.
 */
export function nextSortState(col: string, dir: number, clickedCol: string): { col: string; dir: number } {
  if (col === clickedCol) return { col, dir: -dir };
  return { col: clickedCol, dir: clickedCol === 'fecha' || clickedCol === 'importe' ? -1 : 1 };
}
