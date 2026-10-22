/**
 * Sanitiza un parámetro ?redirect= para uso como destino interno post-auth.
 * Solo rutas relativas que empiezan por "/" (no "//", no "\"", no protocolos).
 */
export function sanitizeInternalRedirect(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (!raw) return fallback;
  const value = String(raw).trim();
  if (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.startsWith('/\\') &&
    !value.includes('\\') &&
    !value.includes('://')
  ) {
    return value;
  }
  return fallback;
}
