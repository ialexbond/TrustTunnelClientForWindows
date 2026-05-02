import { describe, it, expect } from "vitest";
import { parseAgoDuration, formatBanTime } from "./fail2banUtils";

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

  it("localizes days ago in Russian", () => {
    const result = formatBanTime("2 days ago", "ru");
    expect(result).toMatch(/2\s*д/i); // "2 дн. назад"
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
