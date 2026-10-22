import { randomBytes } from 'node:crypto';

/* ------------------------------------------------------------------ */
/*  Bounded metric collector — aggregate only, no public endpoint      */
/* ------------------------------------------------------------------ */

/** Unique request identifier, server-generated, never echoes user data. */
export function generateRequestId(): string {
  return randomBytes(8).toString('hex'); // 16 hex chars, low cardinality
}

/* ---------- dimensions (always bounded) ---------- */

export type AuthMode = 'anonymous' | 'api_key' | 'invalid';

const TOOL_NAMES = [
  'search_licitaciones',
  'get_stats',
  'get_cobertura',
  'search_cpv',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number] | 'other';

/** Normalise a raw tool name to a bounded set. */
export function normTool(raw: string): ToolName {
  const known = TOOL_NAMES as readonly string[];
  for (const name of known) {
    if (raw === name) return name as ToolName;
  }
  return 'other';
}

/* ---------- collected data ---------- */

interface MetricBucket {
  tool: ToolName;
  auth: AuthMode;
  status: string; // '2xx' | '4xx' | '5xx'
  count: number;
  sumDurationMs: number; // total request wall-clock (ms)
  sumUpstreamMs: number; // upstream client wall-clock (ms), 0 if N/A
}

const buckets = new Map<string, MetricBucket>();

function bucketKey(tool: ToolName, auth: AuthMode, status: string): string {
  return `${tool} ${auth} ${status}`;
}

/**
 * Record a completed request.
 * Auth mode is passed explicitly so concurrent requests cannot overwrite
 * each other's attribution.
 *
 * @param tool        - tool name (bounded)
 * @param auth        - request auth mode (bounded)
 * @param statusGroup - '2xx' | '4xx' | '5xx'
 * @param durationMs  - total wall-clock for this request (ms)
 * @param upstreamMs  - upstream call duration only (ms); 0 if no upstream call
 */
export function record(
  tool: ToolName,
  auth: AuthMode,
  statusGroup: string,
  durationMs: number,
  upstreamMs = 0
): void {
  const key = bucketKey(tool, auth, statusGroup);
  const existing = buckets.get(key);
  if (existing) {
    existing.count += 1;
    existing.sumDurationMs += durationMs;
    existing.sumUpstreamMs += upstreamMs;
  } else {
    buckets.set(key, {
      tool,
      auth,
      status: statusGroup,
      count: 1,
      sumDurationMs: durationMs,
      sumUpstreamMs: upstreamMs,
    });
  }
}

/**
 * Snapshot of all buckets.  Never returns raw request data.
 */
export function snapshot(): Array<
  Omit<MetricBucket, 'sumDurationMs' | 'sumUpstreamMs'> & {
    count: number;
    avgDurationMs: number;
    avgUpstreamMs: number;
  }
> {
  return [...buckets.values()].map((b) => ({
    ...b,
    count: b.count,
    avgDurationMs: Math.round(b.sumDurationMs / b.count),
    avgUpstreamMs: Math.round(b.sumUpstreamMs / b.count),
  }));
}

/** Clear all collected buckets (for tests). */
export function reset(): void {
  buckets.clear();
}