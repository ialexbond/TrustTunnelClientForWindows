// configPingToReading — pure mapper unit tests (Phase 12, plan 12-07).
//
// Verifies the ConfigPing (pill band) → decision Reading translation the auto-switch engine
// relies on to reuse the EXISTING inactive-ping data (no second ping loop, T-12-14).
import { describe, it, expect } from "vitest";
import { configPingToReading } from "./configPingToReading";

describe("configPingToReading", () => {
  it("maps numeric bands (green/yellow/red) to an ok reading carrying the ms", () => {
    expect(configPingToReading({ band: "green", valueMs: 42 })).toEqual({ status: "ok", ms: 42 });
    expect(configPingToReading({ band: "yellow", valueMs: 200 })).toEqual({ status: "ok", ms: 200 });
    expect(configPingToReading({ band: "red", valueMs: 480 })).toEqual({ status: "ok", ms: 480 });
  });

  it("maps timeout to an unreachable reading", () => {
    expect(configPingToReading({ band: "timeout" })).toEqual({ status: "unreachable" });
  });

  it("maps no-data / missing to a no-data reading", () => {
    expect(configPingToReading({ band: "no-data" })).toEqual({ status: "no-data" });
    expect(configPingToReading(undefined)).toEqual({ status: "no-data" });
  });

  it("treats an in-flight re-measure (measuring) conservatively as no-data", () => {
    // The pill carries the PRIOR band while re-measuring; for a switch decision we report no-data
    // until a fresh value lands — never switch TO a config whose current value we are unsure of.
    expect(configPingToReading({ band: "measuring" })).toEqual({ status: "no-data" });
  });

  it("degrades a numeric band with no valueMs to no-data instead of emitting NaN", () => {
    expect(configPingToReading({ band: "green" })).toEqual({ status: "no-data" });
  });
});
