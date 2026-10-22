import type { IncomingHttpHeaders } from 'node:http';

const API_KEY_PATTERN = /^elicita_live_[0-9a-fA-F]{32}_[0-9a-fA-F]{48}$/;

export type RequestCredential =
  | { status: 'anonymous'; apiKey: '' }
  | { status: 'credential_present'; apiKey: string; credential: 'api_key' }
  | { status: 'invalid'; apiKey: '' };

export function hasDirectApiKeyFormat(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}

export function resolveRequestCredential(
  headers: Pick<IncomingHttpHeaders, 'authorization'>
): RequestCredential {
  const authorization = headers.authorization;
  if (authorization !== undefined && typeof authorization !== 'string') {
    return { status: 'invalid', apiKey: '' };
  }
  return resolveAuthorizationCredential(authorization);
}

/** Accepts the same direct Bearer API key contract on Fetch-native handlers. */
export function resolveAuthorizationCredential(authorization: string | null | undefined): RequestCredential {
  if (authorization === undefined || authorization === null) {
    return { status: 'anonymous', apiKey: '' };
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) {
    return { status: 'invalid', apiKey: '' };
  }

  const bearer = match[1];
  if (hasDirectApiKeyFormat(bearer)) {
    return { status: 'credential_present', apiKey: bearer, credential: 'api_key' };
  }

  return { status: 'invalid', apiKey: '' };
}
