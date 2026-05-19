/**
 * Benchmark output parser — minimal version (UAT 2026-05-19 round 3).
 *
 * Backend `server_run_benchmark` returns only `raw_stdout`.
 * This module extracts the SVG report link and preserves raw output.
 *
 * Pure module — no Tauri, no React, no DOM.
 *
 * B5: This is the SOLE Phase 17 parser. Backend Rust returns raw_stdout only.
 */

// ── Exported types ──────────────────────────────────────────────────────────

export interface ParsedSections {
  /** Report link extracted from Check.Place output (https://Report.Check.Place/ip/XXX.svg) */
  reportLink?: string;
  /** Full raw stdout */
  raw: string;
}

// ── ANSI stripping ──────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[mGKJHF]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// ── Report link extraction ───────────────────────────────────────────────────

const REPORT_LINK_RE = /Report Link:\s+(https?:\/\/\S+\.svg)/i;

export function extractReportLink(raw: string): string | undefined {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const m = stripAnsi(lines[i]).match(REPORT_LINK_RE);
    if (m) return m[1];
  }
  return undefined;
}

// ── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parses raw Check.Place stdout into ParsedSections.
 *
 * - Never throws
 * - Always returns raw field
 * - Extracts reportLink if present in last 10 lines
 */
export function parseBenchmarkOutput(raw: string): ParsedSections {
  const result: ParsedSections = { raw };

  if (!raw || !raw.trim()) {
    return result;
  }

  try {
    result.reportLink = extractReportLink(raw);
  } catch {
    // non-critical
  }

  return result;
}
