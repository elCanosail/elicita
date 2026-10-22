/**
 * ContextualHelp — tooltips vanilla para el dashboard
 * Uso: añade data-help="texto de ayuda" a cualquier elemento
 * Se auto-inicializa en DOMContentLoaded
 */
(function() {
  'use strict';

  const helpTexts: Record<string, string> = {
    // Monitor — tabla licitaciones activas
    th_objeto: 'Descripción breve del bien o servicio que se licita. Incluye referencias como expediente y número de anuncio.',
    th_organismo: 'Entidad pública que publica la licitación: ministerio, comunidad autónoma, ayuntamiento, universidad, etc.',
    th_cpv: 'Common Procurement Vocabulary — clasificación europea. Ej: 45 = Construcción, 72 = Informática.',
    th_importe: 'Importe estimado del contrato. Puede ser sin IVA (en licitación) o con IVA (en adjudicación).',
    th_fecha: 'Fecha de publicación del anuncio en el Boletín Oficial o plataforma correspondiente.',
    th_fuente: 'Plataforma de origen: BOE, Tenders Electronic Daily (TED), plataforma autonómica, etc.',
    th_estado: 'Abierta: aún puedes presentar oferta. Cerrada: finalizado el plazo. Adjudicada: ya hay ganador.',
    th_ganador: 'Empresa adjudicataria del contrato. Solo visible en licitaciones ya adjudicadas.',
    th_plazo: 'Tiempo restante para presentar oferta. Se actualiza cada 4 horas.',
    // Explorer
    th_competidor: 'Empresa que compite en tu mismo sector. Filtra por CIF o nombre para comparar actividad.',
    th_mercado: 'Vista agregada del mercado de contratación pública: volumen, tendencias, concentración.',
    th_renovacion: 'Predicción de contratos que van a renovar en los próximos meses basada en fechas de finalización.',
    th_terminal: 'Licitaciones con estado final: adjudicadas, desiertas, anuladas. Ya no admiten ofertas, sirven para análisis histórico.',
    th_adjudicatario: 'Empresa ganadora del contrato tras la fase de adjudicación. Incluye NIF si está disponible.',
    // Competidores
    th_empresa: 'Nombre de la empresa competidora. El análisis se basa en concurrencia en contratos de tu mismo perfil CPV.',
    th_coincidencias: 'Número de contratos en los que habéis coincidido como licitadores. Más alto = competencia más directa.',
    th_calidad: 'Puntuación de calidad estimada (0-100) basada en ratios de éxito y volumen. Más alto = competidor más fuerte.',
    th_volumen: 'Importe total adjudicado por el competidor en el período analizado.',
    // Oportunidades de mercado
    th_contratos: 'Número de contratos abiertos detectados para este organismo y sector CPV.',
    th_prevision: 'Estimación del volumen total de licitaciones esperadas basada en patrones históricos.',
    th_periodo: 'Período en que se espera que se publiquen nuevas licitaciones para este organismo/sector.',
    // Proyecciones
    th_organismo_exp: 'Entidad pública para la que se proyecta gasto. Agrupado por comunidad autónoma.',
    th_cpv_exp: 'Sector de contratación proyectado. Calculado a partir de ciclos históricos de renovación.',
    th_monto: 'Monto estimado de gasto público proyectado para el período.',
    // Filtros
    filtro_estado: 'Activa varios filtros simultáneamente para encontrar licitaciones relevantes para tu negocio.',
    filtro_fuente: 'Filtra por plataforma de origen: BOE, TED, autonómica, local, etc.',
    filtro_cpv: 'Selecciona un sector CPV para filtrar licitaciones de tu especialidad.',
    filtro_importe: 'Rango de importe del contrato. útil para enfocar en proyectos de tu tamaño.',
    // General dashboard
    buscador: 'Busca por palabras clave en objeto, organismo o CPV. Usa Enter o espera a la lista desplegable.',
    alertas: 'Recibe notificaciones cuando aparezcan nuevas licitaciones que coincidan con tus criterios.',
    plan: 'Tu plan actual. Free: acceso básico. Pro: alertas + predicciones + análisis de competidores.',
    cif: 'Código de identificación fiscal de tu empresa. Lo usamos para filtrar licitaciones relevantes.',
  };

  function createTooltip(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'ctx-tooltip';
    el.setAttribute('role', 'tooltip');
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    return el;
  }

  const tooltip = createTooltip();
  let activeEl: HTMLElement | null = null;
  let showTimer: number | null = null;
  let hideTimer: number | null = null;

  function positionTooltip(target: HTMLElement): void {
    const rect = target.getBoundingClientRect();
    const ttRect = tooltip.getBoundingClientRect();
    const gap = 8;
    let top = rect.top - ttRect.height - gap;
    let left = rect.left + rect.width / 2 - ttRect.width / 2;

    // Clamp to viewport
    if (left < 8) left = 8;
    if (left + ttRect.width > window.innerWidth - 8) {
      left = window.innerWidth - ttRect.width - 8;
    }
    // Flip to bottom if no space above
    if (top < 8) {
      top = rect.bottom + gap;
    }

    tooltip.style.top = top + window.scrollY + 'px';
    tooltip.style.left = left + 'px';
  }

  function show(text: string, target: HTMLElement): void {
    if (hideTimer) { window.clearTimeout(hideTimer); hideTimer = null; }
    tooltip.textContent = text;
    tooltip.classList.add('ctx-visible');
    tooltip.setAttribute('aria-hidden', 'false');
    activeEl = target;
    // Position after next frame so dimensions are known
    requestAnimationFrame(() => positionTooltip(target));
  }

  function hide(): void {
    tooltip.classList.remove('ctx-visible');
    tooltip.setAttribute('aria-hidden', 'true');
    activeEl = null;
  }

  function scheduleHide(): void {
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 150);
  }

  function init(): void {
    // Auto-bind by data-help attribute
    document.querySelectorAll<HTMLElement>('[data-help]').forEach(el => {
      const key = el.dataset.help;
      if (!key) return;
      const text = helpTexts[key] || key; // fallback: use key as literal text

      el.addEventListener('mouseenter', () => {
        if (showTimer) window.clearTimeout(showTimer);
        showTimer = window.setTimeout(() => show(text, el), 300);
      });
      el.addEventListener('mouseleave', () => {
        if (showTimer) { window.clearTimeout(showTimer); showTimer = null; }
        scheduleHide();
      });
      el.addEventListener('focus', () => show(text, el));
      el.addEventListener('blur', scheduleHide);
    });
  }

  // Auto-init on ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
