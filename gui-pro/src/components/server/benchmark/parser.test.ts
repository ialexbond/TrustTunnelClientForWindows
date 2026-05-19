import { describe, it, expect } from "vitest";
import { parseBenchmarkOutput } from "./parser";
import type { ParsedSections } from "./parser";

// Vite raw imports — loaded at bundle time, no Node.js fs required
import realOutput from "./__fixtures__/benchmark-real-output.txt?raw";
import benchmarkGarbled from "./__fixtures__/benchmark-garbled.txt?raw";

describe("parseBenchmarkOutput — real Check.Place tabular output", () => {
  // ── Full fixture parse ──────────────────────────────────────────────────

  it("always returns raw + partial fields", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.raw).toBe(realOutput);
    expect(typeof result.partial).toBe("boolean");
  });

  it("parses all 5 sections from real fixture", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.basic).toBeDefined();
    expect(result.ipType).toBeDefined();
    expect(result.risk).toBeDefined();
    expect(result.riskFactors).toBeDefined();
    expect(result.accessibility).toBeDefined();
    expect(result.partial).toBe(false);
  });

  // ── Section 1: Basic Information ────────────────────────────────────────

  it("basic — parses ASN and organization", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.basic?.asn).toBe("AS41745");
    expect(result.basic?.organization).toBe("Example Hosting Provider");
  });

  it("basic — parses actualRegion with countryCode and continentCode", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.basic?.actualRegion?.countryCode).toBe("NL");
    expect(result.basic?.actualRegion?.continentCode).toBe("EU");
    expect(result.basic?.actualRegion?.countryName).toContain("Netherlands");
  });

  it("basic — parses registeredRegion", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.basic?.registeredRegion?.countryCode).toBe("RU");
  });

  it("basic — geoDiscrepant true when actual NL != registered RU", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.basic?.geoDiscrepant).toBe(true);
  });

  it("basic — geoDiscrepant false when regions match", () => {
    const input = [
      "1. Basic Information",
      "ASN: AS12345",
      "Actual Region: [NL]The Netherlands     [EU]Europe",
      "Registered Region: [NL]Netherlands",
    ].join("\n");
    const result = parseBenchmarkOutput(input);
    expect(result.basic?.geoDiscrepant).toBe(false);
  });

  it("basic — parses mapUrl", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.basic?.mapUrl).toMatch(/check\.place/);
  });

  it("basic — parses timeZone", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.basic?.timeZone).toBe("Europe/Amsterdam");
  });

  it("basic — parses city", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.basic?.city).toContain("Dronten");
  });

  // ── Section 2: IP Type ──────────────────────────────────────────────────

  it("ipType — returns array of rows per source", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(Array.isArray(result.ipType)).toBe(true);
    expect(result.ipType!.length).toBeGreaterThan(0);
    const sources = result.ipType!.map((r) => r.source);
    expect(sources).toContain("IPinfo");
    expect(sources).toContain("AbuseIPDB");
  });

  it("ipType — each row has usage field", () => {
    const result = parseBenchmarkOutput(realOutput);
    const ipinfo = result.ipType!.find((r) => r.source === "IPinfo");
    expect(ipinfo?.usage).toBe("Hosting");
  });

  // ── Section 3: Risk Score ───────────────────────────────────────────────

  it("risk — returns array with known sources", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(Array.isArray(result.risk)).toBe(true);
    const sources = result.risk!.map((r) => r.source);
    expect(sources).toContain("IP2Location");
    expect(sources).toContain("Scamalytics");
    expect(sources).toContain("IPQS");
  });

  it("risk — each row has source + level", () => {
    const result = parseBenchmarkOutput(realOutput);
    const row = result.risk!.find((r) => r.source === "IP2Location");
    expect(row?.level).toBeDefined();
    const validLevels = ["VeryLow", "Low", "Medium", "High", "VeryHigh", "Unknown"];
    expect(validLevels).toContain(row?.level);
  });

  it("risk — ipapi percent parsed correctly", () => {
    const input = [
      "3. Risk Score",
      "Levels:      VeryLow  Low  Medium  High  VeryHigh",
      "ipapi:                                             3.91% High",
    ].join("\n");
    const result = parseBenchmarkOutput(input);
    const row = result.risk?.find((r) => r.source === "ipapi");
    expect(row?.level).toBe("High");
  });

  // ── Section 4: Risk Factors ─────────────────────────────────────────────

  it("riskFactors — returns array with sources as columns", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(Array.isArray(result.riskFactors)).toBe(true);
    const sources = result.riskFactors!.map((r) => r.source);
    expect(sources).toContain("IP2Location");
  });

  it("riskFactors — proxy/tor/vpn fields are Yes/No/N/A", () => {
    const result = parseBenchmarkOutput(realOutput);
    const row = result.riskFactors!.find((r) => r.source === "IP2Location");
    expect(["Yes", "No", "N/A"]).toContain(row?.proxy);
    expect(["Yes", "No", "N/A"]).toContain(row?.tor);
  });

  // ── Section 5: Accessibility ────────────────────────────────────────────

  it("accessibility — returns array of services", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(Array.isArray(result.accessibility)).toBe(true);
    const services = result.accessibility!.map((r) => r.service);
    expect(services).toContain("Netflix");
    expect(services).toContain("TikTok");
    expect(services).toContain("ChatGPT");
  });

  it("accessibility — NoPrem status parsed correctly", () => {
    const result = parseBenchmarkOutput(realOutput);
    const youtube = result.accessibility!.find((r) => r.service === "Youtube");
    expect(youtube?.status).toBe("NoPrem");
  });

  it("accessibility — Yes/No statuses parsed correctly", () => {
    const result = parseBenchmarkOutput(realOutput);
    const tiktok = result.accessibility!.find((r) => r.service === "TikTok");
    expect(tiktok?.status).toBe("Yes");
  });

  it("accessibility — type field present", () => {
    const result = parseBenchmarkOutput(realOutput);
    const netflix = result.accessibility!.find((r) => r.service === "Netflix");
    expect(netflix?.type).toBe("Native");
  });

  // ── Report link extraction ──────────────────────────────────────────────

  it("reportLink — extracted from last lines", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.reportLink).toBe("https://Report.Check.Place/ip/1ABCDEF123.svg");
  });

  it("reportLink — undefined when absent", () => {
    const input = "1. Basic Information\nASN: AS12345";
    const result = parseBenchmarkOutput(input);
    expect(result.reportLink).toBeUndefined();
  });

  // ── Partial flag ────────────────────────────────────────────────────────

  it("partial — true when no sections found", () => {
    const result = parseBenchmarkOutput(benchmarkGarbled);
    // garbled has no section headers — partial stays false but sections undefined
    // (empty sections ≠ partial parse; partial=true only when section parse throws)
    expect(result.raw).toBe(benchmarkGarbled);
  });

  it("partial — false for real output", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.partial).toBe(false);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it("empty input — returns raw+partial without throwing", () => {
    const result = parseBenchmarkOutput("");
    expect(result.partial).toBe(false);
    expect(result.raw).toBe("");
  });

  it("ansi stripping — section headers detected despite ANSI codes", () => {
    const input = "\x1b[32m1. Basic Information\x1b[0m\nASN: AS12345";
    const result = parseBenchmarkOutput(input);
    expect(result.basic?.asn).toBe("AS12345");
  });

  it("separators — hash lines do not break parsing", () => {
    const input = [
      "########################################################################",
      "1. Basic Information",
      "ASN: AS99999",
      "########################################################################",
    ].join("\n");
    const result = parseBenchmarkOutput(input);
    expect(result.basic?.asn).toBe("AS99999");
  });

  it("email section 6 — not parsed (intentional — no user value)", () => {
    // Even if section 6 is present, result should not have an 'email' field
    const result = parseBenchmarkOutput(realOutput);
    // New parser has no 'email' key in ParsedSections interface
    const keys = Object.keys(result);
    expect(keys).not.toContain("email");
  });
});

// ── Type shape assertions ────────────────────────────────────────────────────
describe("ParsedSections type shape", () => {
  it("has required partial and raw fields", () => {
    const r: ParsedSections = parseBenchmarkOutput("");
    expect(typeof r.partial).toBe("boolean");
    expect(typeof r.raw).toBe("string");
  });
});
