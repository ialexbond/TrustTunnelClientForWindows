/**
 * Benchmark output parser — SOLE Phase 17 section parser per B5.
 *
 * Backend `server_run_benchmark` returns only `raw_stdout`.
 * This module transforms raw stdout into typed ParsedSections consumed by BenchmarkModal.
 *
 * Pure module — no Tauri, no React, no DOM.
 */

export interface ParsedSections {
  basic?: Record<string, string>;
  ip_type?: Record<string, string>;
  /** Sections 3 (Risk Score) and 4 (Risk Factors) are merged under `risk` — mirrors backend parse_milestone Strategy A. */
  risk?: Record<string, string>;
  streaming?: Array<{ service: string; status: string }>;
  email?: Record<string, string>;
}

// Section header: "1. Basic Information", "2. IP Type", etc.
const HEADER_RE = /^([1-6])\.\s+(.*)$/;

// Key-value pair: "IP: 1.2.3.4", "Country: Germany", etc.
const KEY_VALUE_RE = /^([\w\s/]+?):\s+(.+)$/;

// Streaming service line: "Netflix: Yes", "Disney+: Restricted", etc.
const STREAMING_LINE_RE = /^([\w\s+/]+):\s+(Yes|No|Originals Only|Restricted|Available|Blocked|.+?)$/i;

// ANSI escape sequences (e.g., ESC[32m ... ESC[0m)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Section separator lines (72 '#' characters)
const SEPARATOR_RE = /^#+$/;

/**
 * Maps section number (1-6) to ParsedSections key.
 * Sections 3 and 4 (Risk Score + Risk Factors) merge into `risk` per D-1.2 / Plan 17-01.
 */
function sectionFromIndex(n: number): keyof ParsedSections | undefined {
  switch (n) {
    case 1: return "basic";
    case 2: return "ip_type";
    case 3:
    case 4: return "risk"; // merge #3 (Risk Score) + #4 (Risk Factors) — same as backend parse_milestone
    case 5: return "streaming";
    case 6: return "email";
    default: return undefined;
  }
}

/**
 * Parses raw IP.Check.Place stdout into typed sections.
 *
 * Tolerant invariants:
 * - Never throws — any exception returns `{}`
 * - Missing sections → key absent in result
 * - Malformed lines → silently skipped
 * - ANSI escape codes stripped per line before matching
 * - Separator-only lines (########) skipped
 *
 * B5: This is the SOLE Phase 17 section parser. Backend Rust returns raw_stdout only.
 */
export function parseBenchmarkOutput(raw: string): ParsedSections {
  try {
    const result: ParsedSections = {};
    let currentSection: keyof ParsedSections | undefined;

    const lines = raw.split("\n");

    for (const rawLine of lines) {
      // Strip ANSI color codes
      const line = rawLine.replace(ANSI_RE, "");
      const trimmed = line.trim();

      // Skip empty lines and separator-only lines
      if (trimmed === "" || SEPARATOR_RE.test(trimmed)) {
        continue;
      }

      // Check for section header
      const headerMatch = trimmed.match(HEADER_RE);
      if (headerMatch) {
        const n = parseInt(headerMatch[1], 10);
        currentSection = sectionFromIndex(n);

        if (currentSection === "streaming") {
          result.streaming = result.streaming ?? [];
        } else if (currentSection) {
          // For risk section (merged 3+4): preserve existing dict if section 4 follows section 3
          (result as Record<string, unknown>)[currentSection] =
            (result as Record<string, unknown>)[currentSection] ?? {};
        }
        continue;
      }

      if (!currentSection) {
        continue;
      }

      if (currentSection === "streaming") {
        const m = trimmed.match(STREAMING_LINE_RE);
        if (m) {
          result.streaming!.push({ service: m[1].trim(), status: m[2].trim() });
        }
      } else {
        const m = trimmed.match(KEY_VALUE_RE);
        if (m) {
          (result[currentSection] as Record<string, string>)[m[1].trim()] = m[2].trim();
        }
      }
    }

    return result;
  } catch {
    return {};
  }
}
