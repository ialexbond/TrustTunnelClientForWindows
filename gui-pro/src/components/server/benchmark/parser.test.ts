import { describe, it, expect } from "vitest";
import { parseBenchmarkOutput, extractReportLink } from "./parser";

// Vite raw imports — loaded at bundle time, no Node.js fs required
import realOutput from "./__fixtures__/benchmark-real-output.txt?raw";
// Dual-stack capture (09-38 R2-F01-e): two IP QUALITY CHECK REPORT blocks —
// an IPv4 block (198.51.*.*) → 3SAHPEZIJ.svg and an IPv6 block (2001:db8:…) →
// 2NR9UEJ9S.svg. Used to prove the v4/v6 link classification by header IP.
import dualStackOutput from "./__fixtures__/benchmark-dual-stack-output.txt?raw";

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

  // ── 09-38 R2-F01-e: two-link classification by block-header IP ─────────────

  // Test A (single-stack regression): the existing single-stack fixture still
  // yields exactly one link. Its block header is the IPv4 198.51.100.42 (dotted,
  // no `:`) → the link lands in the v4 slot; v6 stays undefined; the legacy
  // `reportLink` field still resolves to that single link for back-compat.
  it("single-stack classifies the one link as v4, no v6 (regression)", () => {
    const result = parseBenchmarkOutput(realOutput);
    expect(result.reportLink).toBe("https://Report.Check.Place/ip/1ABCDEF123.svg");
    expect(result.reportLinkV4).toBe("https://Report.Check.Place/ip/1ABCDEF123.svg");
    expect(result.reportLinkV6).toBeUndefined();
  });

  // Test B (dual-stack): each link is classified by the IP in the PRECEDING
  // `IP QUALITY CHECK REPORT …<ip>` header — `:` in the ip → v6, else v4. The
  // IPv4 block precedes 3SAHPEZIJ; the IPv6 block precedes 2NR9UEJ9S.
  it("dual-stack classifies both links by preceding block-header IP (not order)", () => {
    const result = parseBenchmarkOutput(dualStackOutput);
    expect(result.reportLinkV4).toBe("https://Report.Check.Place/ip/3SAHPEZIJ.svg");
    expect(result.reportLinkV6).toBe("https://Report.Check.Place/ip/2NR9UEJ9S.svg");
  });

  // Test C (header form tolerance): a colon header AND a two-space/no-colon
  // header both classify correctly. The single-stack fixture uses the two-space
  // form (`IP QUALITY CHECK REPORT  198.51.100.42`); the dual-stack fixture uses
  // the colon form (`IP QUALITY CHECK REPORT: <ip>`). Synthesize both here.
  it("tolerates both the colon and the two-space header forms", () => {
    const colonV6 = [
      "IP QUALITY CHECK REPORT: 2a00:1450::1",
      "Report Link: https://Report.Check.Place/ip/COLONV6.svg",
    ].join("\n");
    expect(parseBenchmarkOutput(colonV6).reportLinkV6).toBe(
      "https://Report.Check.Place/ip/COLONV6.svg"
    );

    const twoSpaceV4 = [
      "IP QUALITY CHECK REPORT  203.0.113.7",
      "Report Link: https://Report.Check.Place/ip/TWOSP4.svg",
    ].join("\n");
    expect(parseBenchmarkOutput(twoSpaceV4).reportLinkV4).toBe(
      "https://Report.Check.Place/ip/TWOSP4.svg"
    );
  });

  // Test D (no link / empty): never throws; both slots undefined.
  it("empty / link-less input → both slots undefined, never throws", () => {
    expect(() => parseBenchmarkOutput("")).not.toThrow();
    const empty = parseBenchmarkOutput("");
    expect(empty.reportLinkV4).toBeUndefined();
    expect(empty.reportLinkV6).toBeUndefined();

    const noLink = parseBenchmarkOutput("Some garbled text with no headers and no link");
    expect(noLink.reportLinkV4).toBeUndefined();
    expect(noLink.reportLinkV6).toBeUndefined();
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
