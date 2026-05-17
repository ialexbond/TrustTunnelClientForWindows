import { describe, it, expect, beforeEach } from "vitest";
import {
  loadHistory,
  pushHistory,
  clearHistory,
  MAX_RECORDS,
  type BenchmarkRecord,
} from "./history";

function mkRecord(suffix: string): BenchmarkRecord {
  return {
    timestamp: new Date().toISOString(),
    parsed_sections: { tag: suffix },
    raw_stdout: `raw-${suffix}`,
    duration_seconds: 60,
  };
}

describe("benchmark history", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("empty_host_returns_empty_array", () => {
    const result = loadHistory("nonexistent.com");
    expect(result).toEqual([]);
  });

  it("push_then_load_round_trip", () => {
    const record = mkRecord("A");
    pushHistory("example.com", record);
    const loaded = loadHistory("example.com");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].raw_stdout).toBe("raw-A");
    expect(loaded[0].parsed_sections).toEqual({ tag: "A" });
    expect(typeof loaded[0].timestamp).toBe("string");
    expect(typeof loaded[0].duration_seconds).toBe("number");
  });

  it("evicts_oldest_at_6th_push — length stays at MAX_RECORDS", () => {
    // Push 6 records (MAX_RECORDS + 1)
    for (let i = 1; i <= 6; i++) {
      pushHistory("eviction.com", mkRecord(`record-${i}`));
    }
    const loaded = loadHistory("eviction.com");
    expect(loaded).toHaveLength(MAX_RECORDS); // Must be 5
    // Record #1 was shifted out; first remaining is record #2
    expect(loaded[0].raw_stdout).toBe("raw-record-2");
    // Last element is record #6
    expect(loaded[4].raw_stdout).toBe("raw-record-6");
  });

  it("MAX_RECORDS_is_5", () => {
    expect(MAX_RECORDS).toBe(5);
  });

  it("safeKey_normalizes_special_chars — @, :, port preserved properly", () => {
    pushHistory("foo@bar.com:2222", mkRecord("special"));
    // safeKey: "foo_bar.com_2222" (@ → _, : → _)
    const stored = localStorage.getItem("tt_benchmark_foo_bar.com_2222");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].raw_stdout).toBe("raw-special");
  });

  it("loadHistory_returns_empty_on_malformed_json", () => {
    localStorage.setItem("tt_benchmark_badhost", "{not-json-at-all");
    const result = loadHistory("badhost");
    expect(result).toEqual([]);
  });

  it("loadHistory_filters_invalid_records — valid + invalid → only valid returned", () => {
    const validRecord = mkRecord("valid");
    const invalidRecord = { broken: true }; // missing required fields
    localStorage.setItem(
      "tt_benchmark_filter.com",
      JSON.stringify([validRecord, invalidRecord])
    );
    const loaded = loadHistory("filter.com");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].raw_stdout).toBe("raw-valid");
  });

  it("clearHistory_removes_key — loadHistory returns empty after clear", () => {
    pushHistory("clearme.com", mkRecord("X"));
    expect(loadHistory("clearme.com")).toHaveLength(1);
    clearHistory("clearme.com");
    expect(loadHistory("clearme.com")).toEqual([]);
    // Key should be removed from localStorage
    expect(localStorage.getItem("tt_benchmark_clearme.com")).toBeNull();
  });

  it("safeKey_preserves_dots_for_ip — 192.168.1.5 dots intact", () => {
    pushHistory("192.168.1.5", mkRecord("ip"));
    const stored = localStorage.getItem("tt_benchmark_192.168.1.5");
    expect(stored).not.toBeNull();
  });

  it("non_array_json_returns_empty_array", () => {
    localStorage.setItem("tt_benchmark_nonarray.com", '"just a string"');
    const result = loadHistory("nonarray.com");
    expect(result).toEqual([]);
  });

  it("pushHistory_5_times_stays_at_5", () => {
    for (let i = 0; i < 5; i++) {
      pushHistory("stable.com", mkRecord(`s${i}`));
    }
    expect(loadHistory("stable.com")).toHaveLength(5);
    // Additional push should still stay at 5
    pushHistory("stable.com", mkRecord("extra"));
    expect(loadHistory("stable.com")).toHaveLength(5);
  });
});
