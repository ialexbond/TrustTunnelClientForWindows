/**
 * Benchmark history localStorage helpers.
 *
 * Stores last N benchmark results per host under key `tt_benchmark_<host>`.
 * Key prefix strictly follows CLAUDE.md `tt_*` convention.
 *
 * Pure module — no Tauri, no React, no DOM (only localStorage).
 */

export interface BenchmarkRecord {
  /** ISO 8601 timestamp of the benchmark run */
  timestamp: string;
  /** Parsed sections computed by parseBenchmarkOutput — cached for fast history view without re-parsing */
  parsed_sections: Record<string, unknown>;
  /** Full raw stdout from server_run_benchmark (B5 — backend returns raw only) */
  raw_stdout: string;
  /** Duration in seconds */
  duration_seconds: number;
}

/** Maximum number of records stored per host (evict oldest on 6th push) */
export const MAX_RECORDS = 5;

const KEY_PREFIX = "tt_benchmark_";

/**
 * Normalizes host to a safe localStorage key.
 * Input `foo@bar.com:2222` → `tt_benchmark_foo_bar.com_2222`
 * Dots are preserved; colons, @, and other non-alphanumeric chars → underscore.
 */
function safeKey(host: string): string {
  return `${KEY_PREFIX}${host.replace(/[^a-z0-9.]/gi, "_")}`;
}

/**
 * Type guard for BenchmarkRecord.
 * Rejects partial / null / non-object records to prevent localStorage corruption crashes.
 */
function isBenchmarkRecord(x: unknown): x is BenchmarkRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.timestamp === "string" &&
    typeof r.raw_stdout === "string" &&
    typeof r.duration_seconds === "number" &&
    r.parsed_sections !== null &&
    typeof r.parsed_sections === "object"
  );
}

/**
 * Loads benchmark history for a given host.
 * Returns [] for: missing key, malformed JSON, non-array, or array with invalid records.
 * Never throws.
 */
export function loadHistory(host: string): BenchmarkRecord[] {
  try {
    const raw = localStorage.getItem(safeKey(host));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isBenchmarkRecord);
  } catch {
    return [];
  }
}

/**
 * Pushes a new record to history, evicting the oldest when exceeding MAX_RECORDS.
 * After 6th push, length stays bounded to 5 (MAX_RECORDS).
 */
export function pushHistory(host: string, record: BenchmarkRecord): void {
  const current = loadHistory(host);
  current.push(record);
  while (current.length > MAX_RECORDS) current.shift();
  localStorage.setItem(safeKey(host), JSON.stringify(current));
}

/**
 * Removes all benchmark history for the given host.
 */
export function clearHistory(host: string): void {
  localStorage.removeItem(safeKey(host));
}
