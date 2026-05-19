/**
 * Benchmark output parser — SOLE Phase 17 section parser per B5.
 *
 * Backend `server_run_benchmark` returns only `raw_stdout`.
 * This module transforms raw stdout into typed ParsedSections consumed by BenchmarkModal.
 *
 * Pure module — no Tauri, no React, no DOM.
 *
 * 17-fix (2026-05-19): Rewritten for real Check.Place multi-source tabular output.
 * Previous parser assumed simple Key: Value structure — real output has columnar tables.
 */

// ── Exported types ──────────────────────────────────────────────────────────

export interface BasicInfo {
  ip: string;
  asn?: string;
  organization?: string;
  location?: { lat: number; lng: number };
  mapUrl?: string;
  city?: string;
  actualRegion?: {
    countryCode: string;
    countryName: string;
    continentCode: string;
    continentName: string;
  };
  registeredRegion?: {
    countryCode: string;
    countryName: string;
  };
  timeZone?: string;
  /** true when actualRegion.countryCode !== registeredRegion.countryCode */
  geoDiscrepant: boolean;
  ptr?: string;
}

export interface IpTypeRow {
  source: string;
  database?: string;
  usage?: string;
  company?: string;
}

export type RiskLevel = "VeryLow" | "Low" | "Medium" | "High" | "VeryHigh" | "Unknown";

export interface RiskScoreRow {
  source: string;
  score: number;
  level: RiskLevel;
  unit?: "count" | "percent";
}

export interface RiskFactorsRow {
  source: string;
  region?: string;
  proxy?: "Yes" | "No" | "N/A";
  tor?: "Yes" | "No" | "N/A";
  vpn?: "Yes" | "No" | "N/A";
  server?: "Yes" | "No" | "N/A";
  abuser?: "Yes" | "No" | "N/A";
  robot?: "Yes" | "No" | "N/A";
}

export type AccessibilityStatus = "Yes" | "No" | "NoPrem" | "Blocked" | "Unknown";

export interface AccessibilityRow {
  service: string;
  status: AccessibilityStatus;
  region?: string;
  type?: string;
}

export interface ParsedSections {
  basic?: BasicInfo;
  ipType?: IpTypeRow[];
  risk?: RiskScoreRow[];
  riskFactors?: RiskFactorsRow[];
  accessibility?: AccessibilityRow[];
  reportLink?: string;
  /** true if any section failed to parse */
  partial: boolean;
  /** full raw stdout */
  raw: string;
}

// ── ANSI stripping ──────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[mGKJHF]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// ── Section header detection ────────────────────────────────────────────────

const SECTION_HEADER_RE = /^(\d+)\.\s+(.+)$/;

function detectSectionNumber(line: string): number | null {
  const m = stripAnsi(line).trim().match(SECTION_HEADER_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 6 ? n : null;
}

// ── Separator detection ─────────────────────────────────────────────────────

const SEPARATOR_RE = /^[#=]{10,}$/;

function isSeparator(line: string): boolean {
  return SEPARATOR_RE.test(stripAnsi(line).trim());
}

// ── Section 1: Basic Information parser ─────────────────────────────────────

/**
 * Parses region string like "[NL]The Netherlands     [EU]Europe"
 * Returns { countryCode, countryName, continentCode, continentName }
 */
function parseActualRegion(s: string): BasicInfo["actualRegion"] {
  // Format: [CC]Country Name     [CC2]Continent Name
  const re = /\[([A-Z]{2})\]([^[]+)/g;
  const parts: Array<{ code: string; name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    parts.push({ code: m[1], name: m[2].trim() });
  }
  if (parts.length >= 2) {
    return {
      countryCode: parts[0].code,
      countryName: parts[0].name,
      continentCode: parts[1].code,
      continentName: parts[1].name,
    };
  }
  if (parts.length === 1) {
    return {
      countryCode: parts[0].code,
      countryName: parts[0].name,
      continentCode: "",
      continentName: "",
    };
  }
  return undefined;
}

function parseRegisteredRegion(s: string): BasicInfo["registeredRegion"] {
  const m = s.match(/\[([A-Z]{2})\]([^[]+)/);
  if (!m) return undefined;
  return { countryCode: m[1], countryName: m[2].trim() };
}

function parseLocation(s: string): { lat: number; lng: number } | undefined {
  // Format: "5°43'38"E, 52°31'39"N" — extract decimal from degrees
  // Try decimal format first: "52.5275, 5.7271"
  const decM = s.match(/([-\d.]+),\s*([-\d.]+)/);
  if (decM) {
    const a = parseFloat(decM[1]);
    const b = parseFloat(decM[2]);
    if (!isNaN(a) && !isNaN(b)) return { lat: a, lng: b };
  }
  return undefined;
}

function parseBasicInfo(lines: string[]): BasicInfo {
  const info: Partial<BasicInfo> & { geoDiscrepant: boolean } = { geoDiscrepant: false };

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine);
    const trimmed = line.trim();
    if (!trimmed || isSeparator(trimmed)) continue;

    // Generic key: value matching
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim();
    if (!val) continue;

    const keyLower = key.toLowerCase();

    if (keyLower === "ip") {
      info.ip = val;
    } else if (keyLower === "asn") {
      info.asn = val;
    } else if (keyLower === "organization") {
      info.organization = val;
    } else if (keyLower === "location") {
      info.location = parseLocation(val);
    } else if (keyLower === "map") {
      info.mapUrl = val;
    } else if (keyLower === "city") {
      info.city = val;
    } else if (keyLower === "actual region") {
      info.actualRegion = parseActualRegion(val);
    } else if (keyLower === "registered region") {
      info.registeredRegion = parseRegisteredRegion(val);
    } else if (keyLower === "time zone") {
      info.timeZone = val;
    } else if (keyLower === "ptr") {
      info.ptr = val;
    } else if (keyLower === "ip type") {
      // "Geo-discrepant" marker in IP Type field
      if (val.toLowerCase().includes("geo-discrepant")) {
        info.geoDiscrepant = true;
      }
    }
  }

  // Determine geoDiscrepant by comparing regions if not already set
  if (!info.geoDiscrepant && info.actualRegion && info.registeredRegion) {
    if (info.actualRegion.countryCode !== info.registeredRegion.countryCode) {
      info.geoDiscrepant = true;
    }
  }

  return {
    ip: info.ip ?? "",
    asn: info.asn,
    organization: info.organization,
    location: info.location,
    mapUrl: info.mapUrl,
    city: info.city,
    actualRegion: info.actualRegion,
    registeredRegion: info.registeredRegion,
    timeZone: info.timeZone,
    geoDiscrepant: info.geoDiscrepant,
    ptr: info.ptr,
  };
}

// ── Section 2: IP Type parser ────────────────────────────────────────────────

/**
 * Parses columnar IP Type table.
 * Header line: "Database:    IPinfo       ipregistry   ipapi        ..."
 * Value lines: "Usage:       Hosting      Hosting      Hosting      ..."
 */
function parseIpType(lines: string[]): IpTypeRow[] {
  // Find the header line with source names
  let sources: string[] = [];
  const rowData: Record<string, string[]> = {}; // rowName → values per source

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine).trim();
    if (!line || isSeparator(line)) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const rowName = line.slice(0, colonIdx).trim().toLowerCase();
    const rest = line.slice(colonIdx + 1);

    // Split by 2+ spaces (column separators)
    const cells = rest.trim().split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);

    if (rowName === "database") {
      sources = cells;
    } else if (["usage", "company"].includes(rowName)) {
      rowData[rowName] = cells;
    }
  }

  if (sources.length === 0) return [];

  return sources.map((src, i) => ({
    source: src,
    usage: rowData["usage"]?.[i] || undefined,
    company: rowData["company"]?.[i] || undefined,
  }));
}

// ── Section 3+4: Risk Score parser ──────────────────────────────────────────

const RISK_LEVELS: RiskLevel[] = ["VeryLow", "Low", "Medium", "High", "VeryHigh"];

function parseRiskLevel(s: string): RiskLevel {
  const clean = s.trim();
  // Match case-insensitively
  for (const level of RISK_LEVELS) {
    if (clean.toLowerCase() === level.toLowerCase()) return level;
    // Also try "Very Low" → "VeryLow"
    if (clean.toLowerCase().replace(/\s+/, "") === level.toLowerCase()) return level;
  }
  return "Unknown";
}

/**
 * Parses Risk Score section.
 * Format: "IP2Location:   [bar]   3  Low"
 * Or:     "ipapi:         [bar]   3.91% High"
 */
function parseRiskScore(lines: string[]): RiskScoreRow[] {
  const rows: RiskScoreRow[] = [];
  const sourceNames = ["IP2Location", "Scamalytics", "ipapi", "AbuseIPDB", "IPQS", "DB-IP"];

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine).trim();
    if (!line || isSeparator(line)) continue;

    // Skip the "Levels:" header line
    if (line.toLowerCase().startsWith("levels:")) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const sourceName = line.slice(0, colonIdx).trim();
    // Only process known source names (case-insensitive match)
    const knownSource = sourceNames.find(
      (s) => s.toLowerCase() === sourceName.toLowerCase()
    );
    if (!knownSource) continue;

    const rest = line.slice(colonIdx + 1).trim();

    // Extract trailing "score level" pattern — last words
    // Patterns: "3  Low", "17 Low", "3.91% High", "Low" (DB-IP has no numeric score)
    const tokens = rest.trim().split(/\s+/).filter(Boolean);

    // Try to find a level word at the end
    const levelWord = tokens[tokens.length - 1] ?? "";
    const level = parseRiskLevel(levelWord);

    // Extract numeric score (may include %)
    let score = 0;
    let unit: "count" | "percent" | undefined;

    // Look for a number (possibly with %) in tokens
    for (const tok of tokens) {
      const pctMatch = tok.match(/^([\d.]+)%$/);
      if (pctMatch) {
        score = parseFloat(pctMatch[1]);
        unit = "percent";
        break;
      }
      const numMatch = tok.match(/^[\d.]+$/);
      if (numMatch && tok !== levelWord) {
        score = parseFloat(tok);
        unit = "count";
        break;
      }
    }

    rows.push({ source: knownSource, score, level, unit });
  }

  return rows;
}

// ── Section 4: Risk Factors parser ──────────────────────────────────────────

type YesNoNA = "Yes" | "No" | "N/A";

function parseYesNoNA(s: string): YesNoNA {
  const lower = s.toLowerCase().trim();
  if (lower === "yes") return "Yes";
  if (lower === "no") return "No";
  if (lower === "n/a") return "N/A";
  return "N/A"; // fallback
}

/**
 * Parses Risk Factors columnar table.
 * Header: "DB:          IP2Location  ipapi  ..."
 * Rows:   "Proxy:       No           No     ..."
 */
function parseRiskFactors(lines: string[]): RiskFactorsRow[] {
  let sources: string[] = [];
  const rowData: Record<string, YesNoNA[]> = {};
  const regionData: string[] = [];

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine).trim();
    if (!line || isSeparator(line)) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const rowName = line.slice(0, colonIdx).trim().toLowerCase();
    const rest = line.slice(colonIdx + 1).trim();
    const cells = rest.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);

    if (rowName === "db") {
      sources = cells;
    } else if (rowName === "region") {
      // Region: [NL]  [NL]  ...  — extract country codes
      cells.forEach((c, i) => {
        const m = c.match(/\[([A-Z]{2})\]/);
        regionData[i] = m ? m[1] : c;
      });
    } else if (["proxy", "tor", "vpn", "server", "abuser", "robot"].includes(rowName)) {
      rowData[rowName] = cells.map(parseYesNoNA);
    }
  }

  if (sources.length === 0) return [];

  return sources.map((src, i) => ({
    source: src,
    region: regionData[i],
    proxy: rowData["proxy"]?.[i],
    tor: rowData["tor"]?.[i],
    vpn: rowData["vpn"]?.[i],
    server: rowData["server"]?.[i],
    abuser: rowData["abuser"]?.[i],
    robot: rowData["robot"]?.[i],
  }));
}

// ── Section 5: Accessibility parser ─────────────────────────────────────────

function parseAccessibilityStatus(s: string): AccessibilityStatus {
  const lower = s.toLowerCase().trim();
  if (lower === "yes") return "Yes";
  if (lower === "no") return "No";
  if (lower === "noprem") return "NoPrem";
  if (lower === "blocked") return "Blocked";
  return "Unknown";
}

/**
 * Parses Accessibility columnar table.
 * Header: "Service:    TikTok    Disney+   Netflix   ..."
 * Rows:   "Status:     Yes       Yes       Yes       ..."
 */
function parseAccessibility(lines: string[]): AccessibilityRow[] {
  let services: string[] = [];
  const statusData: AccessibilityStatus[] = [];
  const regionData: string[] = [];
  const typeData: string[] = [];

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine).trim();
    if (!line || isSeparator(line)) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const rowName = line.slice(0, colonIdx).trim().toLowerCase();
    const rest = line.slice(colonIdx + 1).trim();
    const cells = rest.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);

    if (rowName === "service") {
      services = cells;
    } else if (rowName === "status") {
      cells.forEach((c, i) => {
        statusData[i] = parseAccessibilityStatus(c);
      });
    } else if (rowName === "region") {
      cells.forEach((c, i) => {
        // Extract country code from [NL] or leave as-is
        const m = c.match(/\[([A-Z]{0,2})\]/);
        regionData[i] = m ? m[1] : c;
      });
    } else if (rowName === "type") {
      cells.forEach((c, i) => {
        typeData[i] = c;
      });
    }
  }

  if (services.length === 0) return [];

  return services.map((svc, i) => ({
    service: svc,
    status: statusData[i] ?? "Unknown",
    region: regionData[i] || undefined,
    type: typeData[i] || undefined,
  }));
}

// ── Report link extraction ───────────────────────────────────────────────────

const REPORT_LINK_RE = /Report Link:\s+(https?:\/\/\S+\.svg)/i;

function extractReportLink(raw: string): string | undefined {
  // Search in last few lines
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const m = stripAnsi(lines[i]).match(REPORT_LINK_RE);
    if (m) return m[1];
  }
  return undefined;
}

// ── Section splitter ─────────────────────────────────────────────────────────

/**
 * Splits raw stdout into per-section line arrays.
 * Returns map: sectionNumber (1-6) → lines[]
 */
function splitIntoSections(raw: string): Map<number, string[]> {
  const map = new Map<number, string[]>();
  let current: number | null = null;
  let currentLines: string[] = [];

  for (const line of raw.split("\n")) {
    const sectionNum = detectSectionNumber(line);
    if (sectionNum !== null) {
      if (current !== null) {
        map.set(current, currentLines);
      }
      current = sectionNum;
      currentLines = [];
      // Don't include the header line itself in the section body
    } else {
      if (current !== null) {
        currentLines.push(line);
      }
    }
  }
  if (current !== null) {
    map.set(current, currentLines);
  }

  return map;
}

// ── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parses raw Check.Place stdout into typed ParsedSections.
 *
 * Tolerant invariants:
 * - Never throws — any section parse failure sets partial=true
 * - Missing sections → field absent in result
 * - Malformed lines → silently skipped per section parser
 * - ANSI escape codes stripped before matching
 * - Email section (6) intentionally NOT rendered — skipped
 * - Always returns raw + partial fields
 *
 * B5: This is the SOLE Phase 17 section parser. Backend Rust returns raw_stdout only.
 */
export function parseBenchmarkOutput(raw: string): ParsedSections {
  const result: ParsedSections = { partial: false, raw };

  if (!raw || !raw.trim()) {
    return { ...result, partial: false };
  }

  // Extract report link from full raw output first
  try {
    result.reportLink = extractReportLink(raw);
  } catch {
    // non-critical
  }

  let sections: Map<number, string[]>;
  try {
    sections = splitIntoSections(raw);
  } catch {
    return { ...result, partial: true };
  }

  // Section 1 — Basic Information
  if (sections.has(1)) {
    try {
      result.basic = parseBasicInfo(sections.get(1)!);
    } catch {
      result.partial = true;
    }
  }

  // Section 2 — IP Type
  if (sections.has(2)) {
    try {
      result.ipType = parseIpType(sections.get(2)!);
    } catch {
      result.partial = true;
    }
  }

  // Sections 3 + 4 — Risk Score + Risk Factors (both present in real output)
  if (sections.has(3)) {
    try {
      result.risk = parseRiskScore(sections.get(3)!);
    } catch {
      result.partial = true;
    }
  }

  if (sections.has(4)) {
    try {
      result.riskFactors = parseRiskFactors(sections.get(4)!);
    } catch {
      result.partial = true;
    }
  }

  // Section 5 — Accessibility
  if (sections.has(5)) {
    try {
      result.accessibility = parseAccessibility(sections.get(5)!);
    } catch {
      result.partial = true;
    }
  }

  // Section 6 (Email) — intentionally NOT parsed (no user value per UAT feedback)

  return result;
}

// ── Legacy compat (Plan 17-02 types kept for history backwards compat) ──────
// Old ParsedSections shape used string-keyed records. New shape is typed.
// history.ts isBenchmarkRecord guard handles migration: old records missing
// new fields get partial=true treatment in BenchmarkModal CompletedView.
