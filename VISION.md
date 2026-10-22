# VISION.md — elicita_

## Principio fundacional

**Convertir complejidad en claridad.**

Elicita opera sobre un dataset de 54.6 millones de registros de contratación pública — una masa de datos que, en bruto, resulta inmanejable. Nuestra función es transformar esa complejidad en inteligencia accesible: información que parece surgir sin esfuerzo, como si siempre hubiera estado ahí esperando.

El usuario no necesita saber que detrás hay nueve fuentes cruzándose en tiempo real, un profiler que analiza miles de adjudicaciones históricas, o un diccionario con 9.454 códigos CPV. Solo necesita abrir su dashboard y ver, con absoluta nitidez, qué contratos le importan, quién compite por ellos, y cuándo vencen.

**La sofisticación del motor es inversamente proporcional a la complejidad de la experiencia.**

## Posición en el mercado

Elicita no es un buscador de licitaciones. Es una plataforma de inteligencia sobre contratación pública.

La diferencia es de naturaleza, no de grado:
- Un buscador te dice qué se ha publicado hoy.
- Elicita te dice qué te importa a ti, por qué, y qué va a pasar después.

Ningún competidor en el mercado español ofrece perfilado automático por CIF contra el histórico completo de adjudicaciones nacionales y europeas. Ese es nuestro diferencial técnico. El diferencial percibido es más simple: **en cinco minutos, Elicita sabe más sobre tu actividad en contratación pública que tú mismo.**

## Referencia de diseño

Token Terminal es la referencia visual y conceptual. No por estética (que también), sino por filosofía: datos financieros complejos presentados con una elegancia que los hace comprensibles de un vistazo.

Aplicado a Elicita:
- **Densidad informativa sin ruido.** Cada elemento en pantalla tiene una razón de ser.
- **Gráficos que cuentan historias.** No decoración — narrativa visual sobre la posición competitiva del cliente.
- **Dark mode nativo.** No es una preferencia cosmética; es el entorno natural para interfaces de datos profesionales.
- **Tipografía como jerarquía.** Inter para legibilidad, JetBrains Mono para datos. Sin excepciones.

## Principios de producto

1. **Datos reales o nada.** Jamás datos ficticios, inventados ni de ejemplo en producción. Si no hay dato real, el espacio queda vacío. La confianza se construye con rigor.

2. **Proyecciones identificadas.** Las predicciones (renovaciones, ciclos, tendencias) están permitidas y son valiosas — siempre que se deriven de datos reales y se identifiquen explícitamente como tales.

3. **Onboarding como momento de revelación.** El usuario introduce su CIF y, en minutos, ve un mapa completo de su actividad en contratación pública. Ese momento —cuando descubre patrones que desconocía sobre su propia empresa— es el punto de conversión.

4. **Menos, pero perfecto.** Antes de añadir cualquier funcionalidad, preguntamos si es necesaria. Si lo es, que sea impecable.

5. **Mobile como contexto real.** El decisor revisa desde el móvil entre reuniones. La experiencia móvil no es una versión reducida — es la versión principal.

## Visión a largo plazo

Elicita aspira a ser la infraestructura de inteligencia sobre la que las empresas españolas toman decisiones de contratación pública. No solo monitorizar — anticipar, perfilar, y optimizar la estrategia de licitación de cada cliente.

El dataset es el foso competitivo. La experiencia de usuario es la puerta de entrada.

## Roadmap avanzado — Análisis semántico de pliegos

**Horizonte:** Fase 4+ (cuando el producto base esté consolidado con clientes de pago)

**La oportunidad:** Hoy Elicita trabaja con datos estructurados (adjudicaciones, importes, fechas, CPVs). Pero el verdadero diferencial competitivo de una empresa en licitaciones está en los **pliegos** — documentos PDF de 50-300 páginas con requisitos técnicos, criterios de valoración, solvencia exigida, y condiciones de ejecución.

**Qué haríamos:**
- Ingesta y análisis automático de pliegos (PDF → knowledge graph)
- Extracción de requisitos clave: solvencia técnica/económica, criterios de adjudicación, penalizaciones, plazos
- Match automático pliego ↔ capacidades de la empresa ("¿cumplo los requisitos de esta licitación?")
- Análisis comparativo: "Este pliego es 80% similar al contrato que ganaste en 2023"
- Generación de resúmenes ejecutivos por pliego

**Tecnología candidata:** [Cognee](https://github.com/topoteretes/cognee) — knowledge engine open source que combina vector search + graph DB + ontología. Convierte documentos no estructurados en conocimiento consultable por agentes AI. Python, integra con LLMs.

**Modelo de negocio:**
- Feature premium (plan Empresa o add-on) — análisis bajo demanda
- Análisis personalizado por cliente: "Analiza este pliego para mi empresa"
- Alertas inteligentes: "Se ha publicado un pliego que encaja con tu perfil al 92%"

**Por qué no ahora:** Requiere LLM en el loop (coste por análisis), infraestructura de embeddings, y un volumen de clientes que justifique la inversión. Primero consolidar el producto base.

---

*"La tecnología más avanzada es indistinguible de la magia." — Arthur C. Clarke*

*En Elicita, la magia es que 54.6 millones de registros se conviertan en una respuesta clara a una pregunta simple: ¿qué contrato debo perseguir?*
