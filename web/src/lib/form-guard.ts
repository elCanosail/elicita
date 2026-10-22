/**
 * Validaciones comunes de los formularios públicos de escritura
 * (feedback, waitlist, contact).
 *
 * Motivo: el parámetro `type`/`_tipo` se interpolaba sin validar en rutas de
 * fichero (`data/feedback/${Date.now()}-${type}.json`) y en el enrutado del
 * formulario de contacto. Aquí se fija una allowlist explícita: cualquier valor
 * fuera de la lista se normaliza a un valor legal (o se rechaza), de modo que
 * un `type` hostil (`../../x`) nunca puede escapar del directorio previsto.
 */

/** Tipos legales del formulario de feedback in-app (dashboard). */
export const FEEDBACK_TYPES = ['bug', 'idea', 'otro'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** Tipos legales del formulario de contacto (`_tipo` oculto). */
export const CONTACT_TYPES = ['perfil', 'simple'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

/** Tope del cuerpo de feedback (caracteres) — corta escrituras de disco abusivas. */
export const FEEDBACK_MESSAGE_MAX = 5000;
/** Longitud máxima razonable de una dirección de email (RFC 5321). */
export const EMAIL_MAX = 254;
/** Tope de entradas de la waitlist antes de rechazar nuevas altas. */
export const WAITLIST_MAX_ENTRIES = 50000;

/** Normaliza el tipo de feedback a la allowlist; cualquier valor desconocido → 'otro'. */
export function normalizeFeedbackType(value: unknown): FeedbackType {
  return typeof value === 'string' && (FEEDBACK_TYPES as readonly string[]).includes(value)
    ? (value as FeedbackType)
    : 'otro';
}

/** true si `_tipo` es uno de los valores legales del formulario de contacto. */
export function isContactType(value: unknown): value is ContactType {
  return typeof value === 'string' && (CONTACT_TYPES as readonly string[]).includes(value);
}

/** Validación mínima de email (longitud ≤ 254 + forma básica). */
export function isValidEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  if (email.length === 0 || email.length > EMAIL_MAX) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Nombre de fichero seguro para un feedback. Al recibir siempre un tipo ya
 * normalizado por la allowlist, el nombre es seguro por construcción (sin
 * separadores ni `..`). `ts` es inyectable para los tests.
 */
export function feedbackFilename(type: FeedbackType, ts: number = Date.now()): string {
  return `${ts}-${type}.json`;
}
