import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatUptime, formatBytes } from "./uptime";

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
