import { describe, it, expect } from "vitest";
import { parseBenchmarkOutput, extractReportLink } from "./parser";

// Vite raw imports — loaded at bundle time, no Node.js fs required
import realOutput from "./__fixtures__/benchmark-real-output.txt?raw";

describe("parseBenchmarkOutput", () => {
  // ── Core invariants ──────────────────────────────────────────────────────

  it("always returns raw field", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.raw).toBe(realOutput);
  });

  it("empty input returns empty raw", () => {
    const result = parseBenchmarkOutput("");
    expect(result.raw).toBe("");
    expect(result.reportLink).toBeUndefined();
  });

  it("whitespace-only input returns raw without link", () => {
    const result = parseBenchmarkOutput("   \n   ");
    expect(result.raw).toBe("   \n   ");
    expect(result.reportLink).toBeUndefined();
  });

  // ── Report link extraction ───────────────────────────────────────────────

  it("extracts reportLink from real output", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.reportLink).toBe("https://Report.Check.Place/ip/1ABCDEF123.svg");
  });

  it("reportLink undefined when absent", () => {
    const result = parseBenchmarkOutput("Some garbled text with no section headers at all");
    expect(result.reportLink).toBeUndefined();
  });

  it("ANSI stripping does not break reportLink detection", () => {
    const withAnsi = "some output\n\x1b[32mReport Link: https://Report.Check.Place/ip/ANSITEST.svg\x1b[0m\n";
    const result = parseBenchmarkOutput(withAnsi);
    expect(result.reportLink).toBe("https://Report.Check.Place/ip/ANSITEST.svg");
  });

  it("raw field always preserved regardless of link presence", () => {
    const raw = "some raw output without a report link";
    expect(parseBenchmarkOutput(raw).raw).toBe(raw);
  });
});

describe("extractReportLink", () => {
  it("finds link in last 10 lines", () => {
    const lines = Array(15).fill("noise line").concat([
      "Report Link: https://Report.Check.Place/ip/FOUND.svg",
    ]);
    expect(extractReportLink(lines.join("\n"))).toBe("https://Report.Check.Place/ip/FOUND.svg");
  });

  it("returns undefined for no link", () => {
    expect(extractReportLink("no link here")).toBeUndefined();
  });
});
