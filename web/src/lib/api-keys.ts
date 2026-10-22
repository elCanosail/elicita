/**
 * API Key management for Elicita
 * Keys stored in DuckDB with SHA-256 hash (never plaintext)
 */
import { createHash, randomBytes } from 'crypto';
import { queryWrite, closeWriteConnection } from './duckdb-write';

const KEY_PREFIX = 'elicita_live_';
const KEY_LENGTH = 64; // Total length: prefix + 32 + 48

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  hash: string; // SHA-256 of full key
  prefix: string; // First 16 chars of key (for display)
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
}

export interface ApiKeyCreateResult {
  key: string; // Full key (shown only once)
  apiKey: ApiKey;
}

/**
 * Generate a new API key
 * Format: elicita_live_<32chars>_<48chars>
 */
export function generateApiKey(userId: string, name: string): ApiKeyCreateResult {
  const id = randomBytes(16).toString('hex');
  const secretPart = randomBytes(24).toString('hex');
  const key = `${KEY_PREFIX}${id}_${secretPart}`;

  const hash = createHash('sha256').update(key).digest('hex');
  const prefix = key.slice(0, 16);

  const apiKey: ApiKey = {
    id,
    userId,
    name,
    hash,
    prefix,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    expiresAt: null,
    revoked: false,
  };

  return { key, apiKey };
}

/**
 * Hash a key for comparison
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Validate key format
 */
export function isValidApiKeyFormat(key: string | null | undefined): boolean {
  if (!key || typeof key !== 'string') return false;
  if (!key.startsWith(KEY_PREFIX)) return false;
  const parts = key.slice(KEY_PREFIX.length).split('_');
  return parts.length === 2 &&
         parts[0].length === 32 &&
         parts[1].length === 48;
}

/**
 * Extract userId from metadata for API-enabled plans
 */
export function getQueriesLimit(plan: string): number {
  switch (plan) {
    case 'pro': return 1000;
    case 'empresa': return 10000;
    default: return 0;
  }
}

export function getRateLimit(plan: string): { maxTokens: number; refillRate: number } {
  switch (plan) {
    case 'pro': return { maxTokens: 100, refillRate: 100 / 60 };
    case 'empresa': return { maxTokens: 500, refillRate: 500 / 60 };
    default: return { maxTokens: 0, refillRate: 0 };
  }
}

export function canUseMcp(plan: string): boolean {
  return plan === 'pro' || plan === 'empresa';
}

function toDateString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function apiKeyFromRow(row: Record<string, any>): ApiKey {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    hash: row.hash,
    prefix: row.prefix,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    lastUsedAt: toDateString(row.last_used_at),
    expiresAt: toDateString(row.expires_at),
    revoked: Boolean(row.revoked),
  };
}

/**
 * Persist a new API key to DuckDB
 */
export async function saveApiKey(apiKey: ApiKey): Promise<void> {
  const sql = `
      INSERT INTO api_keys (id, user_id, name, hash, prefix, created_at, last_used_at, expires_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
  const params = [
    apiKey.id,
    apiKey.userId,
    apiKey.name,
    apiKey.hash,
    apiKey.prefix,
    apiKey.createdAt,
    apiKey.lastUsedAt,
    apiKey.expiresAt,
    apiKey.revoked,
  ];
  await queryWrite(sql, params);
}

/**
 * Look up an API key by its SHA-256 hash
 */
export async function getApiKeyByHash(hash: string): Promise<ApiKey | null> {
  const rows = await queryWrite(`SELECT * FROM api_keys WHERE hash = ? AND revoked = FALSE LIMIT 1`, [hash]);
  if (!rows || rows.length === 0) return null;
  return apiKeyFromRow(rows[0]);
}

/**
 * List all non-revoked API keys for a user
 */
export async function listApiKeysByUser(userId: string): Promise<ApiKey[]> {
  const rows = await queryWrite(
    `SELECT * FROM api_keys WHERE user_id = ? AND revoked = FALSE ORDER BY created_at DESC`,
    [userId]
  );
  return (rows || []).map(apiKeyFromRow);
}

/**
 * Revoke an API key by id
 */
export async function revokeApiKey(id: string): Promise<void> {
  await queryWrite(`UPDATE api_keys SET revoked = TRUE WHERE id = ?`, [id]);
}

/**
 * Update last_used_at timestamp for an API key
 */
export async function updateLastUsed(id: string): Promise<void> {
  await queryWrite(`UPDATE api_keys SET last_used_at = NOW() WHERE id = ?`, [id]);
}

/**
 * Close the write connection (for graceful shutdown)
 */
export { closeWriteConnection };
