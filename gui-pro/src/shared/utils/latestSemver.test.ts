/**
 * latestSemver — co-located tests (Phase 09 Plan 09-13 Task 1, E-17).
 *
 * Pins the semver-max contract: the helper returns the numerically GREATEST
 * version from a list regardless of the list's order (GitHub publish order is
 * NOT semver order — a hotfix for an older minor can be published after a newer
 * minor, so `versions[0]` is unreliable as "latest"). Built on `compareSemver`
 * so the parse rules (strip leading v, drop pre-release after first `-`,
 * numeric-not-lexicographic) stay single-sourced.
 */
import { describe, it, expect } from "vitest";
import { latestSemver } from "./latestSemver";

describe("latestSemver", () => {
  it("returns the semver-max when publish order [0] is an OLDER version", () => {
    // [0] is 1.0.30 (older), the real latest is 1.0.34 buried mid-list.
    expect(latestSemver(["1.0.30", "1.0.34", "1.0.33"])).toBe("1.0.34");
  });

  it("compares numerically, not lexicographically (1.10.0 > 1.9.0)", () => {
    expect(latestSemver(["1.9.0", "1.10.0", "1.2.0"])).toBe("1.10.0");
  });

  it("strips a leading v and returns the original string form of the max", () => {
    // The returned value is the input element verbatim (caller decides display).
    expect(latestSemver(["v1.0.1", "v1.0.3", "v1.0.2"])).toBe("v1.0.3");
  });

  it("returns the single element for a one-item list", () => {
    expect(latestSemver(["1.0.33"])).toBe("1.0.33");
  });

  it("returns an empty string for an empty list", () => {
    expect(latestSemver([])).toBe("");
  });
});
