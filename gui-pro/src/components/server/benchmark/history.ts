/**
 * Benchmark history localStorage helpers.
 *
 * Stores the LAST benchmark result per host under key `tt_benchmark_<host>`.
 * Single-record storage — no eviction logic needed.
 * Key prefix strictly follows CLAUDE.md `tt_*` convention.
 *
 * Migration: if localStorage contains an old v17.x array, returns the first
 * element (newest is stored at index 0 with `push + reverse`, or just take [0]).
 *
 * Pure module — no Tauri, no React, no DOM (only localStorage).
 */

export interface BenchmarkRecord {
  /** ISO 8601 timestamp of the benchmark run */
  timestamp: string;
  /**
   * Parsed sections computed by parseBenchmarkOutput — cached for fast history view without re-parsing.
   * 17-fix: Shape changed to new ParsedSections (typed 5-section tabular output).
   * Old records (pre-17.1) may have old string-keyed shape — isBenchmarkRecord handles migration:
   * if parsed_sections is missing new required fields, BenchmarkModal renders raw fallback.
   */
  parsed_sections: Record<string, unknown>;
  /** Full raw stdout from server_run_benchmark (B5 — backend returns raw only) */
  raw_stdout: string;
  /** Duration in seconds */
  duration_seconds: number;
}

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
 * Loads the last benchmark record for a given host.
 * Returns null for: missing key, malformed JSON, or invalid record shape.
 *
 * Migration: if stored value is an array (old v17.x format), returns the first
 * element (index 0 was the latest in push-to-front or push+bounded-array order).
 * Never throws.
 */
export function loadLast(host: string): BenchmarkRecord | null {
  try {
    const raw = localStorage.getItem(safeKey(host));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);

    // Migration path: old v17.x format stored an array of up to 5 records.
    // Array[0] was the latest (records were appended and bounded to 5,
    // so the 0th is the oldest push; take last element for newest).
    if (Array.isArray(parsed)) {
      // newest is last element (push appended to tail)
      for (let i = parsed.length - 1; i >= 0; i--) {
        if (isBenchmarkRecord(parsed[i])) return parsed[i] as BenchmarkRecord;
      }
      return null;
    }

    return isBenchmarkRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Saves the given record as the single last benchmark result for the host.
 * Overwrites any previous record.
 */
export function saveLast(host: string, record: BenchmarkRecord): void {
  localStorage.setItem(safeKey(host), JSON.stringify(record));
}

/**
 * Removes the benchmark record for the given host.
 */
export function clearLast(host: string): void {
  localStorage.removeItem(safeKey(host));
}
