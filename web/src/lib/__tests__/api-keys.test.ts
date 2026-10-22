/**
 * Tests for web/src/lib/api-keys.ts
 *
 * Tests cover:
 * - generateApiKey (SHA-256 hash, format elicita_live_)
 * - hashApiKey (SHA-256 hashing)
 * - isValidApiKeyFormat (format validation)
 * - revokeApiKey (mocked duckdb-write)
 * - getQueriesLimit, getRateLimit, canUseMcp (pure functions)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock crypto module for deterministic testing ────────────────────

const mockRandomBytes = vi.fn();
const mockCreateHash = vi.fn();

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomBytes: vi.fn((size: number) => {
      return mockRandomBytes(size);
    }),
    createHash: vi.fn((algo: string) => {
      return mockCreateHash(algo);
    }),
  };
});

// ── Mock duckdb-write ───────────────────────────────────────────────

const mockQueryWrite = vi.fn();

vi.mock('../duckdb-write', () => ({
  queryWrite: (...args: any[]) => mockQueryWrite(...args),
  closeWriteConnection: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockRandomBytes.mockImplementation((size: number) => {
    return Buffer.alloc(size, '0');
  });
  mockCreateHash.mockImplementation((_algo: string) => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn().mockReturnValue('mockhash'),
  }));
});

// ── Helper ──────────────────────────────────────────────────────────

async function getApiKeysModule() {
  return await vi.importActual<typeof import('../api-keys')>('../api-keys');
}

// ── generateApiKey tests ───────────────────────────────────────────

describe('generateApiKey', () => {
  it('generates a key with elicita_live_ prefix', async () => {
    const { generateApiKey } = await getApiKeysModule();
    const { key } = generateApiKey('user123', 'My Key');
    expect(key).toMatch(/^elicita_live_/);
  });

  it('generates a key with correct format: prefix + 32chars + 48chars', async () => {
    const { generateApiKey } = await getApiKeysModule();
    const { key } = generateApiKey('user123', 'My Key');
    const parts = key.slice('elicita_live_'.length).split('_');
    expect(parts.length).toBe(2);
    expect(parts[0].length).toBe(32);
    expect(parts[1].length).toBe(48);
  });

  it('returns an apiKey object with required fields', async () => {
    const { generateApiKey } = await getApiKeysModule();
    const { apiKey } = generateApiKey('user123', 'My Key');
    expect(apiKey.id).toBeDefined();
    expect(apiKey.userId).toBe('user123');
    expect(apiKey.name).toBe('My Key');
    expect(apiKey.hash).toBeDefined();
    expect(apiKey.prefix).toBeDefined();
    expect(apiKey.createdAt).toBeDefined();
    expect(apiKey.lastUsedAt).toBeNull();
    expect(apiKey.expiresAt).toBeNull();
    expect(apiKey.revoked).toBe(false);
  });

  it('hash is SHA-256 of the full key', async () => {
    const expectedHash = 'abc123hash';
    mockCreateHash.mockImplementation((_algo: string) => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue(expectedHash),
    }));

    const { generateApiKey } = await getApiKeysModule();
    const { apiKey, key } = generateApiKey('user123', 'My Key');
    expect(apiKey.hash).toBe(expectedHash);
  });

  it('prefix is first 16 chars of the key', async () => {
    const { generateApiKey } = await getApiKeysModule();
    const { apiKey, key } = generateApiKey('user123', 'My Key');
    expect(apiKey.prefix).toBe(key.slice(0, 16));
  });

  it('generates unique keys on repeated calls', async () => {
    const { generateApiKey } = await getApiKeysModule();
    mockRandomBytes.mockImplementation((size: number) => {
      return Buffer.alloc(size, '0');
    });
    mockCreateHash.mockImplementation((_algo: string) => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue('hash1'),
    }));

    const { key: key1 } = generateApiKey('user123', 'Key 1');
    mockRandomBytes.mockImplementation((size: number) => {
      return Buffer.alloc(size, '1');
    });
    mockCreateHash.mockImplementation((_algo: string) => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue('hash2'),
    }));

    const { key: key2 } = generateApiKey('user123', 'Key 2');
    expect(key1).not.toBe(key2);
  });
});

// ── hashApiKey tests ───────────────────────────────────────────────

describe('hashApiKey', () => {
  it('returns SHA-256 hash of the key', async () => {
    const { hashApiKey } = await getApiKeysModule();
    mockCreateHash.mockImplementation((_algo: string) => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue('d41d8cd98f00b204e9800998ecf8427e'),
    }));

    const hash = hashApiKey('elicita_live_test_key');
    expect(hash).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('different keys produce different hashes', async () => {
    const { hashApiKey } = await getApiKeysModule();
    let callIndex = 0;
    mockCreateHash.mockImplementation((_algo: string) => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockImplementation(() => {
        callIndex++;
        return `hash${callIndex}`;
      }),
    }));

    const hash1 = hashApiKey('key1');
    const hash2 = hashApiKey('key2');
    expect(hash1).not.toBe(hash2);
  });
});

// ── isValidApiKeyFormat tests ───────────────────────────────────────

describe('isValidApiKeyFormat', () => {
  it('returns true for valid key format', async () => {
    const { isValidApiKeyFormat } = await getApiKeysModule();
    const validKey = 'elicita_live_' + 'a'.repeat(32) + '_' + 'b'.repeat(48);
    expect(isValidApiKeyFormat(validKey)).toBe(true);
  });

  it('returns false for missing prefix', async () => {
    const { isValidApiKeyFormat } = await getApiKeysModule();
    expect(isValidApiKeyFormat('live_' + 'a'.repeat(32) + '_' + 'b'.repeat(48))).toBe(false);
  });

  it('returns false for wrong id length', async () => {
    const { isValidApiKeyFormat } = await getApiKeysModule();
    const key = 'elicita_live_' + 'a'.repeat(30) + '_' + 'b'.repeat(48);
    expect(isValidApiKeyFormat(key)).toBe(false);
  });

  it('returns false for wrong secret length', async () => {
    const { isValidApiKeyFormat } = await getApiKeysModule();
    const key = 'elicita_live_' + 'a'.repeat(32) + '_' + 'b'.repeat(46);
    expect(isValidApiKeyFormat(key)).toBe(false);
  });

  it('returns false for empty string', async () => {
    const { isValidApiKeyFormat } = await getApiKeysModule();
    expect(isValidApiKeyFormat('')).toBe(false);
  });

  it('returns false for null/undefined', async () => {
    const { isValidApiKeyFormat } = await getApiKeysModule();
    expect(isValidApiKeyFormat(null as any)).toBe(false);
    expect(isValidApiKeyFormat(undefined as any)).toBe(false);
  });

  it('returns false for key without underscore separator', async () => {
    const { isValidApiKeyFormat } = await getApiKeysModule();
    const key = 'elicita_live_' + 'a'.repeat(80);
    expect(isValidApiKeyFormat(key)).toBe(false);
  });
});

// ── getQueriesLimit tests ──────────────────────────────────────────

describe('getQueriesLimit', () => {
  it('returns 1000 for pro plan', async () => {
    const { getQueriesLimit } = await getApiKeysModule();
    expect(getQueriesLimit('pro')).toBe(1000);
  });

  it('returns 10000 for empresa plan', async () => {
    const { getQueriesLimit } = await getApiKeysModule();
    expect(getQueriesLimit('empresa')).toBe(10000);
  });

  it('returns 0 for free/unknown plan', async () => {
    const { getQueriesLimit } = await getApiKeysModule();
    expect(getQueriesLimit('free')).toBe(0);
    expect(getQueriesLimit('unknown')).toBe(0);
  });
});

// ── getRateLimit tests ─────────────────────────────────────────────

describe('getRateLimit', () => {
  it('returns correct rate for pro plan', async () => {
    const { getRateLimit } = await getApiKeysModule();
    const rate = getRateLimit('pro');
    expect(rate.maxTokens).toBe(100);
    expect(rate.refillRate).toBeCloseTo(100 / 60, 4);
  });

  it('returns correct rate for empresa plan', async () => {
    const { getRateLimit } = await getApiKeysModule();
    const rate = getRateLimit('empresa');
    expect(rate.maxTokens).toBe(500);
    expect(rate.refillRate).toBeCloseTo(500 / 60, 4);
  });

  it('returns zero rate for free/unknown plan', async () => {
    const { getRateLimit } = await getApiKeysModule();
    const rate = getRateLimit('free');
    expect(rate.maxTokens).toBe(0);
    expect(rate.refillRate).toBe(0);
  });
});

// ── canUseMcp tests ────────────────────────────────────────────────

describe('canUseMcp', () => {
  it('returns true for pro plan', async () => {
    const { canUseMcp } = await getApiKeysModule();
    expect(canUseMcp('pro')).toBe(true);
  });

  it('returns true for empresa plan', async () => {
    const { canUseMcp } = await getApiKeysModule();
    expect(canUseMcp('empresa')).toBe(true);
  });

  it('returns false for free/unknown plan', async () => {
    const { canUseMcp } = await getApiKeysModule();
    expect(canUseMcp('free')).toBe(false);
    expect(canUseMcp('unknown')).toBe(false);
  });
});

// ── revokeApiKey tests (mocked duckdb-write) ───────────────────────

describe('revokeApiKey', () => {
  it('calls UPDATE with correct SQL', async () => {
    const { revokeApiKey } = await getApiKeysModule();
    mockQueryWrite.mockResolvedValue([]);

    await revokeApiKey('key-id-123');
    expect(mockQueryWrite).toHaveBeenCalledWith(
      'UPDATE api_keys SET revoked = TRUE WHERE id = ?',
      ['key-id-123']
    );
  });

  it('resolves on success', async () => {
    const { revokeApiKey } = await getApiKeysModule();
    mockQueryWrite.mockResolvedValue([]);

    await expect(revokeApiKey('key-id-123')).resolves.toBeUndefined();
  });

  it('rejects on database error', async () => {
    const { revokeApiKey } = await getApiKeysModule();
    mockQueryWrite.mockRejectedValue(new Error('DB error'));

    await expect(revokeApiKey('key-id-123')).rejects.toThrow('DB error');
  });
});

// ── saveApiKey tests (mocked duckdb-write) ─────────────────────────

describe('saveApiKey', () => {
  it('calls INSERT with correct parameters', async () => {
    const { saveApiKey, generateApiKey } = await getApiKeysModule();
    mockQueryWrite.mockResolvedValue([]);

    const { apiKey } = generateApiKey('user123', 'My Key');
    await saveApiKey(apiKey);

    expect(mockQueryWrite).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO api_keys'),
      [
        apiKey.id,
        apiKey.userId,
        apiKey.name,
        apiKey.hash,
        apiKey.prefix,
        apiKey.createdAt,
        apiKey.lastUsedAt,
        apiKey.expiresAt,
        apiKey.revoked,
      ]
    );
  });
});

// ── getApiKeyByHash tests (mocked duckdb-write) ────────────────────

describe('getApiKeyByHash', () => {
  it('returns apiKey when found', async () => {
    const { getApiKeyByHash } = await getApiKeysModule();
    mockQueryWrite.mockResolvedValue([{
      id: 'key-1',
      user_id: 'user123',
      name: 'My Key',
      hash: 'abc123',
      prefix: 'elicita_liv',
      created_at: '2024-01-01T00:00:00.000Z',
      last_used_at: null,
      expires_at: null,
      revoked: 0,
    }]);

    const result = await getApiKeyByHash('abc123');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('key-1');
    expect(result!.userId).toBe('user123');
    expect(result!.name).toBe('My Key');
  });

  it('returns null when not found', async () => {
    const { getApiKeyByHash } = await getApiKeysModule();
    mockQueryWrite.mockResolvedValue([]);

    const result = await getApiKeyByHash('nonexistent');
    expect(result).toBeNull();
  });

  it('excludes revoked keys', async () => {
    const { getApiKeyByHash } = await getApiKeysModule();
    mockQueryWrite.mockImplementation((sql: string) => {
      expect(sql).toContain('revoked = FALSE');
      return Promise.resolve([]);
    });

    await getApiKeyByHash('abc123');
  });
});

// ── listApiKeysByUser tests (mocked duckdb-write) ──────────────────

describe('listApiKeysByUser', () => {
  it('returns list of keys for user', async () => {
    const { listApiKeysByUser } = await getApiKeysModule();
    mockQueryWrite.mockResolvedValue([
      {
        id: 'key-1',
        user_id: 'user123',
        name: 'Key 1',
        hash: 'hash1',
        prefix: 'elicita_liv',
        created_at: '2024-01-01T00:00:00.000Z',
        last_used_at: null,
        expires_at: null,
        revoked: 0,
      },
      {
        id: 'key-2',
        user_id: 'user123',
        name: 'Key 2',
        hash: 'hash2',
        prefix: 'elicita_liv',
        created_at: '2024-02-01T00:00:00.000Z',
        last_used_at: null,
        expires_at: null,
        revoked: 0,
      },
    ]);

    const result = await listApiKeysByUser('user123');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('key-1');
    expect(result[1].id).toBe('key-2');
  });

  it('returns empty array when no keys', async () => {
    const { listApiKeysByUser } = await getApiKeysModule();
    mockQueryWrite.mockResolvedValue([]);

    const result = await listApiKeysByUser('nokey');
    expect(result).toHaveLength(0);
  });

  it('excludes revoked keys from list', async () => {
    const { listApiKeysByUser } = await getApiKeysModule();
    mockQueryWrite.mockImplementation((sql: string) => {
      expect(sql).toContain('revoked = FALSE');
      return Promise.resolve([]);
    });

    await listApiKeysByUser('user123');
  });
});

// ── updateLastUsed tests (mocked duckdb-write) ─────────────────────

describe('updateLastUsed', () => {
  it('calls UPDATE with correct SQL', async () => {
    const { updateLastUsed } = await getApiKeysModule();
    mockQueryWrite.mockResolvedValue([]);

    await updateLastUsed('key-id-123');
    expect(mockQueryWrite).toHaveBeenCalledWith(
      'UPDATE api_keys SET last_used_at = NOW() WHERE id = ?',
      ['key-id-123']
    );
  });

  it('resolves on success', async () => {
    const { updateLastUsed } = await getApiKeysModule();
    mockQueryWrite.mockResolvedValue([]);

    await expect(updateLastUsed('key-id-123')).resolves.toBeUndefined();
  });

  it('rejects on DB error', async () => {
    const { updateLastUsed } = await getApiKeysModule();
    mockQueryWrite.mockRejectedValue(new Error('DB error'));

    await expect(updateLastUsed('key-id-123')).rejects.toThrow('DB error');
  });
});