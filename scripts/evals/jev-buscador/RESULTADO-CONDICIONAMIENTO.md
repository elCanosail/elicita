# Test de condicionamiento JEV para re-ranking del buscador — 2026-09-20

Estado: consulta del usuario como texto. 6 candidatos mezclados (3 de búsqueda "informatica", 3 de "fachada").
2 llamadas noul (state=consulta, 1 pregunta por candidato). 0,8 s total, ~$0,0004.

## Matriz
| candidato | Q "equipos informáticos portátiles" | Q "rehabilitación de fachada" |
|---|---|---|
| Suministro de cámaras y auriculares | 0.04 | 0.02 |
| Soporte servidores grabación | 0.03 | 0.02 |
| Instrumental no sanitario | 0.03 | 0.02 |
| Obras reparación fachada IES | 0.02 | **0.93** |
| Redacción/dirección obra fachada posterior | 0.01 | **0.61** |
| Ampliación muro cortina estación | 0.01 | 0.14 |

## Veredicto: CONDICIONAMIENTO SUPERADO
- La columna "fachada" discrimina con gradiente semántico perfecto: obra directa 0.93 > proyecto 0.61 > adyacente (muro cortina) 0.14 > no relacionadas 0.02-0.04.
- Ningún candidato era realmente un portátil → puntuaciones bajas en la columna informática son conducta correcta (JEV responde "¿encaja claramente?", no "¿cuál es menos malo?").
- Implicación de diseño: usar JEV para ORDENAR dentro de un lote de candidatos (re-ranking relativo), nunca como gate absoluto.

## Siguiente paso (spike)
Eval set con encaje conocido (consultas ↔ adjudicaciones reales), medir MRR/recall@5 del re-ranking vs orden clásico, latencia y coste por búsqueda (skill jev-type-safe-validation pasos 2-4).
