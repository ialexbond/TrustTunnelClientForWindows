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
  /**
   * Legacy single report link (back-compat) — the LAST `Report Link:` line seen
   * in the output. On a single-stack run this equals the one link; on a
   * dual-stack run it equals the IPv6 link (the second block). Existing callers
   * that only need "a link" keep working. New callers should prefer the
   * family-classified `reportLinkV4` / `reportLinkV6` fields below.
   */
  reportLink?: string;
  /**
   * Report link of the IPv4 block (09-38 R2-F01-e). Classified by the IP in the
   * preceding `IP QUALITY CHECK REPORT …<ip>` header (no `:` in the IP → v4).
   */
  reportLinkV4?: string;
  /**
   * Report link of the IPv6 block (09-38 R2-F01-e). Classified by the IP in the
   * preceding `IP QUALITY CHECK REPORT …<ip>` header (`:` in the IP → v6).
   */
  reportLinkV6?: string;
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

// Block-header regex (09-38). The IPQuality script prints one header per IP it
// checks. Two real-world forms exist in our fixtures:
//   - colon form (dual-stack capture):  `IP QUALITY CHECK REPORT: 198.51.*.*`
//   - two-space form (single-stack):    `IP QUALITY CHECK REPORT  198.51.100.42`
// So we tolerate an OPTIONAL `:` and flexible whitespace, then capture the IP
// token. We classify the family by whether the captured IP contains a `:`
// (IPv6) or not (IPv4) — NOT by block order, which is unreliable.
const BLOCK_HEADER_RE = /IP QUALITY CHECK REPORT\s*:?\s+(\S+)/i;

function classifyFamily(ip: string): "v4" | "v6" {
  // An IPv6 address always contains at least one colon; IPv4 (and the masked
  // `198.51.*.*` form) never does.
  return ip.includes(":") ? "v6" : "v4";
}

export function extractReportLink(raw: string): string | undefined {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const m = stripAnsi(lines[i]).match(REPORT_LINK_RE);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Scan the whole output top-to-bottom, tracking the current block's IP family
 * (set by each `IP QUALITY CHECK REPORT …<ip>` header). When a `Report Link:`
 * line follows, the link is assigned to the current family's slot. Single-stack
 * output (one block) fills exactly one slot.
 *
 * Pure — never throws.
 */
function classifyReportLinks(raw: string): {
  reportLinkV4?: string;
  reportLinkV6?: string;
} {
  let currentFamily: "v4" | "v6" | null = null;
  let reportLinkV4: string | undefined;
  let reportLinkV6: string | undefined;

  for (const rawLine of raw.split("\n")) {
    const line = stripAnsi(rawLine);

    const header = line.match(BLOCK_HEADER_RE);
    if (header) {
      currentFamily = classifyFamily(header[1]);
      continue;
    }

    const link = line.match(REPORT_LINK_RE);
    if (link) {
      // If no header preceded the link (malformed output), default to v4 so a
      // lone link is never dropped — single-stack runs always have a header.
      const family = currentFamily ?? "v4";
      if (family === "v6") reportLinkV6 = link[1];
      else reportLinkV4 = link[1];
    }
  }

  return { reportLinkV4, reportLinkV6 };
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

  try {
    const { reportLinkV4, reportLinkV6 } = classifyReportLinks(raw);
    result.reportLinkV4 = reportLinkV4;
    result.reportLinkV6 = reportLinkV6;
  } catch {
    // non-critical — family classification is best-effort
  }

  return result;
}
