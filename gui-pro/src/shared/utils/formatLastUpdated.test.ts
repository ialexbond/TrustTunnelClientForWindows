import { describe, it, expect } from "vitest";
import { formatLastUpdated } from "./formatLastUpdated";

describe("formatLastUpdated", () => {
  it("formats as DD.MM.YYYY HH:MM (date first)", () => {
    // 2026-06-23 18:05 local time
    const d = new Date(2026, 5, 23, 18, 5);
    expect(formatLastUpdated(d)).toBe("23.06.2026 18:05");
  });

  it("zero-pads single-digit hours, minutes, day and month", () => {
    // 2026-01-05 09:07 local time
    const d = new Date(2026, 0, 5, 9, 7);
    expect(formatLastUpdated(d)).toBe("05.01.2026 09:07");
  });

  it("keeps midnight as 00:00", () => {
    const d = new Date(2026, 11, 31, 0, 0);
    expect(formatLastUpdated(d)).toBe("31.12.2026 00:00");
  });
});
