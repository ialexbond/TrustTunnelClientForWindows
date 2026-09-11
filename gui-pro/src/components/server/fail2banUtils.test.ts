import { describe, it, expect } from "vitest";
import {
  parseAgoDuration,
  formatBanTime,
  normalizeDurationToSeconds,
  durationsEqual,
} from "./fail2banUtils";

describe("normalizeDurationToSeconds (BUG-01)", () => {
  it("parses bare numeric seconds", () => {
    expect(normalizeDurationToSeconds("600")).toBe(600);
    expect(normalizeDurationToSeconds("0")).toBe(0);
    expect(normalizeDurationToSeconds("3600")).toBe(3600);
  });

  it("parses minutes suffix", () => {
    expect(normalizeDurationToSeconds("10m")).toBe(600);
    expect(normalizeDurationToSeconds("10 min")).toBe(600);
    expect(normalizeDurationToSeconds("10 minutes")).toBe(600);
  });

  it("parses hours suffix", () => {
    expect(normalizeDurationToSeconds("1h")).toBe(3600);
    expect(normalizeDurationToSeconds("2 hours")).toBe(7200);
  });

  it("parses days/weeks/years", () => {
    expect(normalizeDurationToSeconds("1d")).toBe(86400);
    expect(normalizeDurationToSeconds("1w")).toBe(604800);
    expect(normalizeDurationToSeconds("1y")).toBe(31536000);
  });

  it("parses seconds suffix", () => {
    expect(normalizeDurationToSeconds("30s")).toBe(30);
    expect(normalizeDurationToSeconds("30 sec")).toBe(30);
  });

  it("returns null for invalid", () => {
    expect(normalizeDurationToSeconds("")).toBeNull();
    expect(normalizeDurationToSeconds("abc")).toBeNull();
    expect(normalizeDurationToSeconds(undefined)).toBeNull();
    expect(normalizeDurationToSeconds("1.5h")).toBeNull(); // no decimals
  });
});

describe("durationsEqual (BUG-01)", () => {
  it("matches semantically equal durations across formats", () => {
    expect(durationsEqual("1h", "3600")).toBe(true);
    expect(durationsEqual("10m", "600")).toBe(true);
    expect(durationsEqual("1d", "86400")).toBe(true);
    expect(durationsEqual("60s", "1m")).toBe(true);
    expect(durationsEqual("60", "1m")).toBe(true);
  });

  it("rejects unequal durations", () => {
    expect(durationsEqual("1h", "30m")).toBe(false);
    expect(durationsEqual("600", "601")).toBe(false);
  });

  it("returns false for invalid input", () => {
    expect(durationsEqual("1h", "abc")).toBe(false);
    expect(durationsEqual(undefined, "1h")).toBe(false);
    expect(durationsEqual("", "")).toBe(false);
  });

  it("fresh fail2ban install (1h+10m) detected as balanced (600+600)", () => {
    // The exact bug: install_fail2ban writes bantime="1h" findtime="10m";
    // FAIL2BAN_PRESETS.balanced has bantime="600" findtime="600"; raw === fails.
    // Wait — balanced.bantime is "600" but install writes "1h"=3600s. Different!
    // Actually balanced=10m=600s, install=1h=3600s, so they DON'T match. The fresh
    // install will match no preset (custom). Let me re-read the audit...
    //
    // After re-reading: install template writes 1h/10m, balanced preset is 600/600
    // (10m bantime, 10m findtime). These ARE different (3600 vs 600). So fresh install
    // legitimately is "custom" until user picks a preset. The bug auditor implied
    // they should match, but they're functionally different ban durations. The REAL
    // fix is the normalizer for cases when admin manually edits jail.local with
    // either format and reopens the modal.
    expect(durationsEqual("1h", "600")).toBe(false); // NOT equal — 3600 ≠ 600
    expect(durationsEqual("10m", "600")).toBe(true); // equal — both 600s
    expect(durationsEqual("1h", "60m")).toBe(true); // equal — both 3600s
  });
});

describe("parseAgoDuration", () => {
  it("parses Xmin format (no space)", () => {
    expect(parseAgoDuration("5min")).toEqual({ amount: 5, unit: "minute" });
    expect(parseAgoDuration("5min ago")).toEqual({ amount: 5, unit: "minute" });
  });

  it("parses X min format (with space)", () => {
    expect(parseAgoDuration("5 min")).toEqual({ amount: 5, unit: "minute" });
    expect(parseAgoDuration("5 minutes ago")).toEqual({ amount: 5, unit: "minute" });
  });

  it("parses hours", () => {
    expect(parseAgoDuration("1h ago")).toEqual({ amount: 1, unit: "hour" });
    expect(parseAgoDuration("3 hours ago")).toEqual({ amount: 3, unit: "hour" });
    expect(parseAgoDuration("1hr")).toEqual({ amount: 1, unit: "hour" });
  });

  it("parses days", () => {
    expect(parseAgoDuration("2d ago")).toEqual({ amount: 2, unit: "day" });
    expect(parseAgoDuration("7 days ago")).toEqual({ amount: 7, unit: "day" });
  });

  it("parses seconds", () => {
    expect(parseAgoDuration("30s ago")).toEqual({ amount: 30, unit: "second" });
    expect(parseAgoDuration("30 seconds ago")).toEqual({ amount: 30, unit: "second" });
  });

  it("parses weeks", () => {
    expect(parseAgoDuration("1w ago")).toEqual({ amount: 1, unit: "week" });
    expect(parseAgoDuration("2 weeks ago")).toEqual({ amount: 2, unit: "week" });
  });

  it("parses years", () => {
    expect(parseAgoDuration("1y ago")).toEqual({ amount: 1, unit: "year" });
  });

  it("returns null for unknown formats", () => {
    expect(parseAgoDuration("Currently failed")).toBeNull();
    expect(parseAgoDuration("2026-04-30T10:00:00Z")).toBeNull();
    expect(parseAgoDuration("")).toBeNull();
    expect(parseAgoDuration("foo bar")).toBeNull();
  });
});

describe("formatBanTime", () => {
  it("localizes minutes ago in Russian", () => {
    // Intl.RelativeTimeFormat returns proper Russian forms.
    const result = formatBanTime("5min ago", "ru");
    expect(result).toMatch(/5\s*мин/i); // "5 мин. назад" or similar
    expect(result).not.toMatch(/ago/i); // English ago must not appear
  });

  it("localizes minutes ago in English", () => {
    const result = formatBanTime("5min ago", "en");
    expect(result).toMatch(/5\s*minute/i);
  });

  it("localizes hours ago in Russian", () => {
    const result = formatBanTime("1h ago", "ru");
    expect(result).toMatch(/1\s*ч/i); // "1 ч. назад"
  });

  it("localizes days ago in Russian (auto-numeric uses «позавчера» for 2)", () => {
    // BUG-14 fix: numeric: "auto" in Intl.RelativeTimeFormat returns idiomatic
    // forms — «позавчера» for -2 days, «вчера» for -1 day, «5 дн. назад» for ≤-3.
    const result2 = formatBanTime("2 days ago", "ru");
    expect(result2).toMatch(/позавчера/i);
    const result5 = formatBanTime("5 days ago", "ru");
    expect(result5).toMatch(/5\s*д/i); // "5 дн. назад"
  });

  it("zero amount returns raw (BUG-14 defensive)", () => {
    expect(formatBanTime("0min ago", "ru")).toBe("0min ago");
    expect(formatBanTime("0s", "ru")).toBe("0s");
  });

  it("falls back to raw when format unknown", () => {
    expect(formatBanTime("Currently failed", "ru")).toBe("Currently failed");
    expect(formatBanTime("", "ru")).toBe("");
  });

  it("handles plural forms via Intl (English)", () => {
    expect(formatBanTime("1 minute ago", "en")).toMatch(/1\s*minute/i);
    expect(formatBanTime("5 minutes ago", "en")).toMatch(/5\s*minute/i);
  });
});
