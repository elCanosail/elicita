import * as React from "react";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip";
import { HelpCircle } from "lucide-react";

const helpTexts: Record<string, string> = {
  objeto:
    "Descripción breve del bien o servicio que se licita. Incluye referencias como expediente y número de anuncio.",
  organismo:
    "Entidad pública que publica la licitación: ministerio, comunidad autónoma, ayuntamiento, universidad, etc.",
  cpv: "Common Procurement Vocabulary — clasificación europea. Ej: 45 = Construcción, 72 = Informática.",
  importe:
    "Importe estimado del contrato. Puede ser sin IVA (en licitación) o con IVA (en adjudicación).",
  fecha: "Fecha de publicación del anuncio en el Boletín Oficial o plataforma correspondiente.",
  fuente:
    "Plataforma de origen: BOE, Tenders Electronic Daily (TED), plataforma autonómica, etc.",
  estado:
    "Abierta: aún puedes presentar oferta. Cerrada: finalizado el plazo. Adjudicada: ya hay ganador.",
  buscador:
    "Busca por palabras clave en objeto, organismo o CPV. Usa Enter o espera a la lista desplegable.",
  filtros:
    "Activa varios filtros simultáneamente para encontrar licitaciones relevantes para tu negocio.",
  alertas:
    "Recibe notificaciones cuando aparezcan nuevas licitaciones que coincidan con tus criterios.",
  terminal:
    "Licitaciones con estado final (adjudicadas, desiertas, anuladas) que ya no admiten ofertas.",
  competidores:
    "Análisis de empresas que compiten en tu mismo sector. Filtra por CIF o nombre.",
  renovaciones:
    "Predicción de contratos que van a renovar en los próximos meses basada en fechas de finalización.",
  oportunidades:
    "Licitaciones abiertas filtradas por tu sector y tamaño. Actualizadas cada 4 horas.",
  proyecciones: "Proyecciones de gasto público por sector y comunidad autónoma para los próximos trimestres.",
  mercado: "Vista agregada del mercado de contratación pública: volumen, tendencias, concentración.",
  universo: "Conjunto completo de licitaciones disponibles en la plataforma (activas + históricas).",
  plan: "Tu plan actual. Free: acceso básico. Pro: alertas + predicciones + análisis de competidores.",
  cif: "Código de identificación fiscal de tu empresa. Lo usamos para filtrar licitaciones relevantes.",
};

export function ContextualHelp({ topic }: { topic: string }) {
  const text = helpTexts[topic];
  if (!text) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors cursor-help ml-1 align-middle"
            aria-label={`Ayuda: ${topic}`}
          >
            <HelpCircle className="w-2.5 h-2.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function HelpBadge({ topic }: { topic: string }) {
  const text = helpTexts[topic];
  if (!text) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors cursor-help ml-1 align-middle">
            <HelpCircle className="w-2.5 h-2.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
