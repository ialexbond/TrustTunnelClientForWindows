import { describe, it, expect, beforeEach } from "vitest";
import {
  loadLast,
  saveLast,
  clearLast,
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

  it("empty_host_returns_null", () => {
    const result = loadLast("nonexistent.com");
    expect(result).toBeNull();
  });

  it("saveLast_then_loadLast_round_trip", () => {
    const record = mkRecord("A");
    saveLast("example.com", record);
    const loaded = loadLast("example.com");
    expect(loaded).not.toBeNull();
    expect(loaded!.raw_stdout).toBe("raw-A");
    expect(loaded!.parsed_sections).toEqual({ tag: "A" });
    expect(typeof loaded!.timestamp).toBe("string");
    expect(typeof loaded!.duration_seconds).toBe("number");
  });

  it("saveLast_overwrites_previous_record", () => {
    saveLast("overwrite.com", mkRecord("first"));
    saveLast("overwrite.com", mkRecord("second"));
    const loaded = loadLast("overwrite.com");
    expect(loaded).not.toBeNull();
    expect(loaded!.raw_stdout).toBe("raw-second");
  });

  it("safeKey_normalizes_special_chars — @, :, port preserved properly", () => {
    saveLast("foo@bar.com:2222", mkRecord("special"));
    // safeKey: "foo_bar.com_2222" (@ → _, : → _)
    const stored = localStorage.getItem("tt_benchmark_foo_bar.com_2222");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as unknown;
    expect(typeof parsed).toBe("object");
    expect((parsed as { raw_stdout: string }).raw_stdout).toBe("raw-special");
  });

  it("loadLast_returns_null_on_malformed_json", () => {
    localStorage.setItem("tt_benchmark_badhost", "{not-json-at-all");
    const result = loadLast("badhost");
    expect(result).toBeNull();
  });

  it("loadLast_returns_null_for_invalid_record", () => {
    localStorage.setItem(
      "tt_benchmark_filter.com",
      JSON.stringify({ broken: true })
    );
    const result = loadLast("filter.com");
    expect(result).toBeNull();
  });

  it("clearLast_removes_key — loadLast returns null after clear", () => {
    saveLast("clearme.com", mkRecord("X"));
    expect(loadLast("clearme.com")).not.toBeNull();
    clearLast("clearme.com");
    expect(loadLast("clearme.com")).toBeNull();
    // Key should be removed from localStorage
    expect(localStorage.getItem("tt_benchmark_clearme.com")).toBeNull();
  });

  it("safeKey_preserves_dots_for_ip — 192.168.1.5 dots intact", () => {
    saveLast("192.168.1.5", mkRecord("ip"));
    const stored = localStorage.getItem("tt_benchmark_192.168.1.5");
    expect(stored).not.toBeNull();
  });

  // ── Migration tests: old v17.x array format ──

  it("migration_old_array_format_returns_last_element", () => {
    // Old format: array of records (newest is last per push-append logic)
    const records = [mkRecord("old-1"), mkRecord("old-2"), mkRecord("old-3")];
    localStorage.setItem("tt_benchmark_migrate.com", JSON.stringify(records));
    const loaded = loadLast("migrate.com");
    // Should return last element (newest)
    expect(loaded).not.toBeNull();
    expect(loaded!.raw_stdout).toBe("raw-old-3");
  });

  it("migration_old_array_with_invalid_records_returns_valid", () => {
    const validRecord = mkRecord("valid");
    const invalidRecord = { broken: true };
    localStorage.setItem(
      "tt_benchmark_migrate2.com",
      JSON.stringify([invalidRecord, validRecord])
    );
    const loaded = loadLast("migrate2.com");
    expect(loaded).not.toBeNull();
    expect(loaded!.raw_stdout).toBe("raw-valid");
  });

  it("migration_empty_array_returns_null", () => {
    localStorage.setItem("tt_benchmark_empty-arr.com", JSON.stringify([]));
    const result = loadLast("empty-arr.com");
    expect(result).toBeNull();
  });
});
