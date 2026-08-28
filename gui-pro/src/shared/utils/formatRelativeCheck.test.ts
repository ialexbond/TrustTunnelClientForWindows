import { describe, it, expect } from "vitest";
import { formatRelativeCheck } from "./formatRelativeCheck";

// Every case passes an EXPLICIT `now`, so not one of them depends on the wall clock:
// a relative formatter tested against `new Date()` is a test that changes its own
// answer between the two lines that read the clock, and it fails once a year at the
// DST boundary for reasons that have nothing to do with the formatter.
//
// Local-time constructors (`new Date(y, m, d, h)`) rather than ISO literals for the
// reference instants: the calendar-day comparison inside the formatter is a LOCAL one
// («вчера» is a fact about the user's calendar, not about UTC), so the fixtures have to
// be built in the same frame or the yesterday case would pass or fail by time zone.
const NOW = new Date(2026, 7, 27, 14, 30, 0); // 27.08.2026 14:30 local

/** An ISO string for a local wall-clock moment, so the fixture reads as the date it means. */
function localIso(
  year: number,
  month1to12: number,
  day: number,
  hour: number,
  minute = 0,
): string {
  return new Date(year, month1to12 - 1, day, hour, minute, 0).toISOString();
}

describe("formatRelativeCheck", () => {
  it("null returns null — the caller renders no last-check line at all", () => {
    expect(formatRelativeCheck(null, NOW)).toBeNull();
  });

  it("undefined returns null", () => {
    expect(formatRelativeCheck(undefined, NOW)).toBeNull();
  });

  it("an unparseable input returns null rather than an «Invalid Date» phrase", () => {
    expect(formatRelativeCheck("не дата", NOW)).toBeNull();
    expect(formatRelativeCheck("", NOW)).toBeNull();
  });

  it("under a minute returns the just-now key with no interpolation values", () => {
    const result = formatRelativeCheck(localIso(2026, 8, 27, 14, 30), NOW);
    expect(result).toEqual({ key: "about.when_just_now" });
    expect(result?.values).toBeUndefined();
  });

  it("one to fifty-nine minutes returns the minutes key with the minute count", () => {
    expect(formatRelativeCheck(localIso(2026, 8, 27, 14, 29), NOW)).toEqual({
      key: "about.when_minutes",
      values: { count: 1 },
    });
    expect(formatRelativeCheck(localIso(2026, 8, 27, 13, 31), NOW)).toEqual({
      key: "about.when_minutes",
      values: { count: 59 },
    });
  });

  it("one to twenty-three hours returns the hours key with the hour count", () => {
    expect(formatRelativeCheck(localIso(2026, 8, 27, 13, 30), NOW)).toEqual({
      key: "about.when_hours",
      values: { count: 1 },
    });
    // 23 hours back crosses midnight into the previous calendar day and is STILL read
    // as hours: inside a day the exact distance is the more useful fact, and «вчера»
    // starts where the hour count stops being one a reader can hold.
    expect(formatRelativeCheck(localIso(2026, 8, 26, 15, 30), NOW)).toEqual({
      key: "about.when_hours",
      values: { count: 23 },
    });
  });

  it("the previous calendar day returns the yesterday key with no interpolation values", () => {
    // 27.08 14:30 minus 25 hours = 26.08 13:30 — one calendar day back.
    const result = formatRelativeCheck(localIso(2026, 8, 26, 13, 30), NOW);
    expect(result).toEqual({ key: "about.when_yesterday" });
    expect(result?.values).toBeUndefined();
  });

  it("two or more days returns the days key with the day count", () => {
    expect(formatRelativeCheck(localIso(2026, 8, 25, 13, 30), NOW)).toEqual({
      key: "about.when_days",
      values: { count: 2 },
    });
    expect(formatRelativeCheck(localIso(2026, 8, 17, 9, 0), NOW)).toEqual({
      key: "about.when_days",
      values: { count: 10 },
    });
  });

  it("a timestamp in the future is read as just-now and never yields a negative count", () => {
    // A clock that jumped backwards, or a machine whose time is simply wrong, must not
    // make the card say «-7 минут назад». The last check did happen; the honest reading
    // of a moment the app cannot place in the past is «только что».
    const result = formatRelativeCheck(localIso(2026, 8, 27, 16, 0), NOW);
    expect(result).toEqual({ key: "about.when_just_now" });
    expect(result?.values).toBeUndefined();
  });

  it("the same input against the same reference instant returns an identical result", () => {
    const iso = localIso(2026, 8, 27, 12, 0);
    expect(formatRelativeCheck(iso, NOW)).toEqual(formatRelativeCheck(iso, NOW));
    expect(formatRelativeCheck(iso, NOW)).toEqual({
      key: "about.when_hours",
      values: { count: 2 },
    });
  });

  it("every key it can return is one of the five it declares", () => {
    // The dead-key gate is a substring match over the corpus: a key assembled from
    // pieces is invisible to it and gets reported dead. This case pins the returnable
    // set so a future branch cannot quietly widen it past what ru.json carries.
    const KNOWN = [
      "about.when_just_now",
      "about.when_minutes",
      "about.when_hours",
      "about.when_yesterday",
      "about.when_days",
    ];
    const samples = [
      localIso(2026, 8, 27, 14, 30),
      localIso(2026, 8, 27, 14, 0),
      localIso(2026, 8, 27, 10, 0),
      localIso(2026, 8, 26, 13, 30),
      localIso(2026, 8, 20, 13, 30),
    ];
    for (const iso of samples) {
      expect(KNOWN).toContain(formatRelativeCheck(iso, NOW)?.key);
    }
  });
});
