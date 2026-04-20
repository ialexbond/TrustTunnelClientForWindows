import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TFunction } from "i18next";
import { formatUptime, formatBytes, formatServerUptime } from "./uptime";

const mockT = ((key: string, params?: Record<string, unknown>) => {
  if (params) return `${key}:${JSON.stringify(params)}`;
  return key;
}) as TFunction;

describe("formatUptime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 00:00:00 for 0 seconds ago", () => {
    const now = new Date(2024, 0, 1, 12, 0, 0);
    vi.setSystemTime(now);
    expect(formatUptime(now)).toBe("00:00:00");
  });

  it("returns 00:01:01 for 61 seconds ago", () => {
    const now = new Date(2024, 0, 1, 12, 0, 0);
    vi.setSystemTime(now);
    const since = new Date(now.getTime() - 61 * 1000);
    expect(formatUptime(since)).toBe("00:01:01");
  });

  it("returns 01:01:01 for 3661 seconds ago", () => {
    const now = new Date(2024, 0, 1, 12, 0, 0);
    vi.setSystemTime(now);
    const since = new Date(now.getTime() - 3661 * 1000);
    expect(formatUptime(since)).toBe("01:01:01");
  });

  it("returns 25:01:01 for 90061 seconds ago", () => {
    const now = new Date(2024, 0, 1, 12, 0, 0);
    vi.setSystemTime(now);
    const since = new Date(now.getTime() - 90061 * 1000);
    expect(formatUptime(since)).toBe("25:01:01");
  });
});

describe("formatBytes", () => {
  it("returns '0 B' for 0 bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("returns '512 B' for 512 bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("returns '1023 B' for 1023 bytes", () => {
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("returns '1.0 KB' for 1024 bytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("returns '1.5 KB' for 1536 bytes", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("returns '1.0 MB' for 1048576 bytes", () => {
    expect(formatBytes(1048576)).toBe("1.0 MB");
  });

  it("returns '2.5 MB' for 2621440 bytes", () => {
    expect(formatBytes(2621440)).toBe("2.5 MB");
  });

  it("returns '1.00 GB' for 1073741824 bytes", () => {
    expect(formatBytes(1073741824)).toBe("1.00 GB");
  });
});

describe("formatServerUptime", () => {
  it("returns em-dash for 0 seconds", () => {
    expect(formatServerUptime(0, mockT)).toBe("—");
  });

  it("returns em-dash for negative values", () => {
    expect(formatServerUptime(-1, mockT)).toBe("—");
  });

  it("returns em-dash for NaN", () => {
    expect(formatServerUptime(Number.NaN, mockT)).toBe("—");
  });

  it("formats sub-minute uptime as mins=0", () => {
    expect(formatServerUptime(30, mockT)).toBe(
      'server.overview.uptimeFormat.mins:{"mins":0}',
    );
  });

  it("formats 60 seconds as 1 minute", () => {
    expect(formatServerUptime(60, mockT)).toBe(
      'server.overview.uptimeFormat.mins:{"mins":1}',
    );
  });

  it("formats 3599 seconds as 59 minutes", () => {
    expect(formatServerUptime(3599, mockT)).toBe(
      'server.overview.uptimeFormat.mins:{"mins":59}',
    );
  });

  it("formats 3660 seconds as 1 hour 1 minute", () => {
    // 3660 = 1*3600 + 1*60
    expect(formatServerUptime(3660, mockT)).toBe(
      'server.overview.uptimeFormat.hoursMins:{"hours":1,"mins":1}',
    );
  });

  it("formats 86399 seconds as 23 hours 59 minutes (still <1 day)", () => {
    // 86399 = 23*3600 + 59*60 + 59
    expect(formatServerUptime(86399, mockT)).toBe(
      'server.overview.uptimeFormat.hoursMins:{"hours":23,"mins":59}',
    );
  });

  it("formats 86400 seconds as 1 day 0 hours", () => {
    expect(formatServerUptime(86400, mockT)).toBe(
      'server.overview.uptimeFormat.daysHours:{"days":1,"hours":0}',
    );
  });

  it("formats 90061 seconds as 1 day 1 hour", () => {
    // 90061 = 1*86400 + 1*3600 + 1*60 + 1
    expect(formatServerUptime(90061, mockT)).toBe(
      'server.overview.uptimeFormat.daysHours:{"days":1,"hours":1}',
    );
  });

  it("formats 172800 seconds as 2 days 0 hours", () => {
    expect(formatServerUptime(172800, mockT)).toBe(
      'server.overview.uptimeFormat.daysHours:{"days":2,"hours":0}',
    );
  });

  it("formats fractional seconds by flooring minutes", () => {
    // 3719.9 → 1ч 1м (floor)
    expect(formatServerUptime(3719.9, mockT)).toBe(
      'server.overview.uptimeFormat.hoursMins:{"hours":1,"mins":1}',
    );
  });
});
