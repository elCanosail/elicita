/**
 * Tests for web/src/lib/api-usage.ts
 *
 * Tests cover:
 * - checkQueryBudget (mocked queryWrite)
 * - incrementQueryCount (mocked duckdb-write)
 * - checkRateLimit (token bucket — in-memory, pure logic)
 * - consumeDailySearch (mocked queryWrite — consume atómico de la tarea 37,
 *   sustituye al par checkDailySearchLimit/incrementDailySearchCount; los
 *   tests de carrera con BD real viven en api-usage-race.test.ts)
 * - getUsageStats (mocked queryWrite)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock duckdb-write ───────────────────────────────────────────────

const mockQueryWrite = vi.fn();

vi.mock('../duckdb-write', () => ({
  queryWrite: (...args: any[]) => mockQueryWrite(...args),
  closeWriteConnection: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Fake timers for checkRateLimit tests
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Helper ──────────────────────────────────────────────────────────

async function getApiUsageModule() {
  return await vi.importActual<typeof import('../api-usage')>('../api-usage');
}

// ── checkQueryBudget tests ─────────────────────────────────────────

describe('checkQueryBudget', () => {
  it('returns allowed=true when under limit', async () => {
    mockQueryWrite.mockResolvedValue([{ queries_used: 50 }]);
    const { checkQueryBudget } = await getApiUsageModule();

    const result = await checkQueryBudget('user1', 1000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(950);
  });

  it('returns allowed=false when at limit', async () => {
    mockQueryWrite.mockResolvedValue([{ queries_used: 1000 }]);
    const { checkQueryBudget } = await getApiUsageModule();

    const result = await checkQueryBudget('user1', 1000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('returns allowed=true when usage is 0', async () => {
    mockQueryWrite.mockResolvedValue([{ queries_used: 0 }]);
    const { checkQueryBudget } = await getApiUsageModule();

    const result = await checkQueryBudget('user1', 1000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1000);
  });

  it('handles missing rows as 0 usage', async () => {
    mockQueryWrite.mockResolvedValue([]);
    const { checkQueryBudget } = await getApiUsageModule();

    const result = await checkQueryBudget('user1', 1000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1000);
  });

  it('handles undefined queries_used as 0', async () => {
    mockQueryWrite.mockResolvedValue([{}]);
    const { checkQueryBudget } = await getApiUsageModule();

    const result = await checkQueryBudget('user1', 1000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1000);
  });

  it('passes correct SQL and params', async () => {
    mockQueryWrite.mockResolvedValue([{ queries_used: 0 }]);
    const { checkQueryBudget } = await getApiUsageModule();

    await checkQueryBudget('user1', 500);
    expect(mockQueryWrite).toHaveBeenCalledWith(
      'SELECT queries_used FROM api_usage_monthly WHERE user_id = ? AND month = ?',
      ['user1', expect.any(String)]
    );
  });
});

// ── incrementQueryCount tests ──────────────────────────────────────

describe('incrementQueryCount', () => {
  it('calls INSERT with UPSERT', async () => {
    mockQueryWrite.mockResolvedValue([]);
    const { incrementQueryCount } = await getApiUsageModule();

    await incrementQueryCount('user1');
    expect(mockQueryWrite).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO api_usage_monthly'),
      ['user1', expect.any(String)]
    );
  });

  it('uses ON CONFLICT UPSERT clause', async () => {
    mockQueryWrite.mockImplementation((sql: string) => {
      // ensureUsageTables (tarea 37) emite los CREATE UNIQUE INDEX antes del
      // INSERT — la aserción aplica solo al statement de incremento.
      if (sql.includes('INSERT INTO api_usage_monthly')) {
        expect(sql).toContain('ON CONFLICT');
        expect(sql).toContain('DO UPDATE');
      }
      return Promise.resolve([]);
    });
    const { incrementQueryCount } = await getApiUsageModule();

    await incrementQueryCount('user1');
  });

  it('resolves on success', async () => {
    mockQueryWrite.mockResolvedValue([]);
    const { incrementQueryCount } = await getApiUsageModule();

    await expect(incrementQueryCount('user1')).resolves.toBeUndefined();
  });

  it('rejects on DB error', async () => {
    mockQueryWrite.mockRejectedValue(new Error('DB error'));
    const { incrementQueryCount } = await getApiUsageModule();

    await expect(incrementQueryCount('user1')).rejects.toThrow('DB error');
  });
});

// ── checkRateLimit tests (token bucket) ────────────────────────────

describe('checkRateLimit', () => {
  it('allows first request and creates bucket', async () => {
    const { checkRateLimit } = await getApiUsageModule();
    const result = checkRateLimit('user1', 100, 100 / 60);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(99); // 100 - 1
    expect(result.resetTime).toBeDefined();
  });

  it('allows requests until tokens exhausted', async () => {
    const { checkRateLimit } = await getApiUsageModule();
    // Consume tokens
    for (let i = 0; i < 10; i++) {
      const result = checkRateLimit('user1', 100, 100 / 60);
      expect(result.allowed).toBe(true);
    }

    const result = checkRateLimit('user1', 100, 100 / 60);
    expect(result.allowed).toBe(true);
  });

  it('rejects when tokens exhausted', async () => {
    const { checkRateLimit } = await getApiUsageModule();
    const maxTokens = 5;
    // Drain all tokens
    for (let i = 0; i < maxTokens; i++) {
      checkRateLimit('user1', maxTokens, 100 / 60);
    }

    const result = checkRateLimit('user1', maxTokens, 100 / 60);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('refills tokens over time', async () => {
    const { checkRateLimit } = await getApiUsageModule();
    // Use 5 tokens from a 10-token bucket
    for (let i = 0; i < 5; i++) {
      checkRateLimit('user1', 10, 10 / 60);
    }

    // Advance time by 6 seconds = ~1 token refilled (10/60 * 6)
    vi.advanceTimersByTime(6000);

    const result = checkRateLimit('user1', 10, 10 / 60);
    expect(result.allowed).toBe(true);
  });

  it('does not exceed maxTokens on refill', async () => {
    const { checkRateLimit } = await getApiUsageModule();
    // Use 5 tokens
    for (let i = 0; i < 5; i++) {
      checkRateLimit('user1', 10, 100 / 60);
    }

    // Wait a long time so refill would exceed max
    vi.advanceTimersByTime(3600000);

    // First request should still cap at max
    const result = checkRateLimit('user1', 10, 100 / 60);
    expect(result.remaining).toBeLessThanOrEqual(10);
  });

  it('has separate buckets per user', async () => {
    const { checkRateLimit } = await getApiUsageModule();
    checkRateLimit('user1', 5, 1);
    checkRateLimit('user1', 5, 1);
    checkRateLimit('user1', 5, 1);
    checkRateLimit('user1', 5, 1);
    checkRateLimit('user1', 5, 1);

    const user1Result = checkRateLimit('user1', 5, 1);
    const user2Result = checkRateLimit('user2', 5, 1);

    expect(user1Result.allowed).toBe(false);
    expect(user2Result.allowed).toBe(true);
  });

  it('returns correct resetTime for first request', async () => {
    const { checkRateLimit } = await getApiUsageModule();
    const result = checkRateLimit('user1', 10, 10 / 60);
    expect(result.resetTime).toBeGreaterThan(Date.now() / 1000);
  });

  it('returns zero remaining when blocked', async () => {
    const { checkRateLimit } = await getApiUsageModule();
    for (let i = 0; i < 3; i++) {
      checkRateLimit('user1', 3, 1);
    }
    const result = checkRateLimit('user1', 3, 1);
    expect(result.remaining).toBe(0);
  });
});

// ── consumeDailySearch tests (tarea 37: consume atómico) ──────────

describe('consumeDailySearch', () => {
  it('returns allowed=true with remaining=1 after consuming the 2nd search', async () => {
    // RETURNING search_count = 2 → remaining = 3 - 2 = 1
    mockQueryWrite.mockResolvedValue([{ search_count: 2 }]);
    const { consumeDailySearch } = await getApiUsageModule();

    const result = await consumeDailySearch('user1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.limit).toBe(3);
  });

  it('returns allowed=true, remaining=0 when the consume reaches the limit', async () => {
    mockQueryWrite.mockResolvedValue([{ search_count: 3 }]);
    const { consumeDailySearch } = await getApiUsageModule();

    const result = await consumeDailySearch('user1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.limit).toBe(3);
  });

  it('returns allowed=false when the guard blocks the consume (0 filas)', async () => {
    // Conflicto con guard `search_count < 3` incumplido → RETURNING vacío.
    mockQueryWrite.mockResolvedValue([]);
    const { consumeDailySearch } = await getApiUsageModule();

    const result = await consumeDailySearch('user1');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.limit).toBe(3);
  });

  it('first consume of the day (fresh insert) allows with remaining=2', async () => {
    mockQueryWrite.mockResolvedValue([{ search_count: 1 }]);
    const { consumeDailySearch } = await getApiUsageModule();

    const result = await consumeDailySearch('user1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
    expect(result.limit).toBe(3);
  });

  it('consumes with a single guarded UPSERT + RETURNING statement', async () => {
    mockQueryWrite.mockResolvedValue([{ search_count: 1 }]);
    const { consumeDailySearch } = await getApiUsageModule();

    await consumeDailySearch('user1');
    const consumeCall = mockQueryWrite.mock.calls.find((c: any[]) =>
      String(c[0]).includes('INSERT INTO api_usage_daily')
    );
    expect(consumeCall).toBeDefined();
    const sql = String(consumeCall![0]);
    expect(sql).toContain('ON CONFLICT (user_id, date)');
    expect(sql).toContain('DO UPDATE SET search_count = api_usage_daily.search_count + 1');
    expect(sql).toContain('WHERE api_usage_daily.search_count < 3');
    expect(sql).toContain('RETURNING search_count');
    expect(consumeCall![1]).toEqual(['user1', expect.any(String)]);
  });

  it('rejects on DB error', async () => {
    mockQueryWrite.mockRejectedValue(new Error('DB error'));
    const { consumeDailySearch } = await getApiUsageModule();

    await expect(consumeDailySearch('user1')).rejects.toThrow('DB error');
  });
});

// ── getUsageStats tests ────────────────────────────────────────────

describe('getUsageStats', () => {
  it('returns usage stats with queriesUsed from DB', async () => {
    mockQueryWrite.mockResolvedValue([{ queries_used: 42 }]);
    const { getUsageStats } = await getApiUsageModule();

    const result = await getUsageStats('user1');
    expect(result.queriesUsed).toBe(42);
    expect(result.queriesLimit).toBe(0); // not persisted, defaults to 0
    expect(result.queriesRemaining).toBe(0);
    expect(result.month).toBeDefined();
  });

  it('returns 0 usage when no rows', async () => {
    mockQueryWrite.mockResolvedValue([]);
    const { getUsageStats } = await getApiUsageModule();

    const result = await getUsageStats('user1');
    expect(result.queriesUsed).toBe(0);
    expect(result.queriesRemaining).toBe(0);
  });

  it('returns current month', async () => {
    mockQueryWrite.mockResolvedValue([]);
    const { getUsageStats } = await getApiUsageModule();

    const result = await getUsageStats('user1');
    const now = new Date();
    const expectedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expect(result.month).toBe(expectedMonth);
  });

  it('queries correct table and params', async () => {
    mockQueryWrite.mockResolvedValue([{ queries_used: 0 }]);
    const { getUsageStats } = await getApiUsageModule();

    await getUsageStats('user1');
    expect(mockQueryWrite).toHaveBeenCalledWith(
      'SELECT queries_used FROM api_usage_monthly WHERE user_id = ? AND month = ?',
      ['user1', expect.any(String)]
    );
  });
});