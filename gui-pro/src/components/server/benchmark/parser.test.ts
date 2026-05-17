import { describe, it, expect } from "vitest";
import { parseBenchmarkOutput } from "./parser";

// Vite raw imports — loaded at bundle time, no Node.js fs required
import benchmarkSample from "./__fixtures__/benchmark-sample.txt?raw";
import benchmarkGarbled from "./__fixtures__/benchmark-garbled.txt?raw";

describe("parseBenchmarkOutput", () => {
  it("parses_full_fixture — all 5 logical sections present", () => {
    const result = parseBenchmarkOutput(benchmarkSample);
    expect(result.basic).toBeDefined();
    expect(result.ip_type).toBeDefined();
    expect(result.risk).toBeDefined();
    expect(result.streaming).toBeDefined();
    expect(result.email).toBeDefined();
    // basic must contain IP key
    expect(result.basic!["IP"]).toBeDefined();
  });

  it("streaming_returns_array_of_service_status", () => {
    const result = parseBenchmarkOutput(benchmarkSample);
    expect(Array.isArray(result.streaming)).toBe(true);
    expect(result.streaming!.length).toBeGreaterThanOrEqual(4);
    const first = result.streaming![0];
    expect(typeof first.service).toBe("string");
    expect(typeof first.status).toBe("string");
    expect(first.service.length).toBeGreaterThan(0);
    expect(first.status.length).toBeGreaterThan(0);
  });

  it("merges_section_3_and_4_into_risk — B5/D-1.2 invariant", () => {
    // Mirrors backend parse_milestone Risk merge (Plan 17-01 Strategy A)
    const input = [
      "3. Risk Score",
      "Score: 42",
      "4. Risk Factors",
      "Factors: tor",
    ].join("\n");
    const result = parseBenchmarkOutput(input);
    expect(result.risk).toBeDefined();
    expect(result.risk!["Score"]).toBe("42");
    expect(result.risk!["Factors"]).toBe("tor");
  });

  it("tolerant_garbled_returns_empty_object", () => {
    const result = parseBenchmarkOutput(benchmarkGarbled);
    expect(Object.keys(result).length).toBe(0);
  });

  it("strips_ansi_codes", () => {
    const input = "1. Basic\n\x1b[31mIP\x1b[0m: 1.2.3.4";
    const result = parseBenchmarkOutput(input);
    expect(result.basic).toBeDefined();
    expect(result.basic!["IP"]).toBe("1.2.3.4");
  });

  it("skips_separators — 72-hash lines do not cause errors", () => {
    const input = [
      "1. Basic Information",
      "IP: 1.2.3.4",
      "########################################################################",
      "2. IP Type",
      "Type: Hosting",
    ].join("\n");
    let result: ReturnType<typeof parseBenchmarkOutput> | undefined;
    expect(() => {
      result = parseBenchmarkOutput(input);
    }).not.toThrow();
    expect(result!.basic!["IP"]).toBe("1.2.3.4");
    expect(result!.ip_type!["Type"]).toBe("Hosting");
  });

  it("empty_input_returns_empty_object", () => {
    const result = parseBenchmarkOutput("");
    expect(Object.keys(result).length).toBe(0);
  });

  it("streaming_services_parsed_correctly — fixture Netflix/Disney+/YouTube/ChatGPT", () => {
    const result = parseBenchmarkOutput(benchmarkSample);
    const services = result.streaming!.map((s) => s.service);
    expect(services).toContain("Netflix");
    expect(services).toContain("Disney+");
  });

  it("lines_before_first_section_are_skipped", () => {
    const input = [
      "==== IP QUALITY CHECK REPORT ====",
      "some random header line",
      "",
      "1. Basic Information",
      "IP: 10.0.0.1",
    ].join("\n");
    const result = parseBenchmarkOutput(input);
    expect(result.basic!["IP"]).toBe("10.0.0.1");
  });

  it("risk_section_merges_both_score_and_factors_from_fixture", () => {
    const result = parseBenchmarkOutput(benchmarkSample);
    // fixture has section 3 (Score, Risk Level, Proxy) and section 4 (Factors, Blacklisted, Fraud Score)
    expect(result.risk!["Score"]).toBeDefined();
    expect(result.risk!["Factors"]).toBeDefined();
  });

  it("unknown_section_number_is_ignored", () => {
    const input = [
      "7. Unknown Section",
      "Key: Value",
      "1. Basic Information",
      "IP: 5.6.7.8",
    ].join("\n");
    const result = parseBenchmarkOutput(input);
    // Only basic section should be present
    expect(result.basic!["IP"]).toBe("5.6.7.8");
    expect(Object.keys(result).length).toBe(1);
  });
});
