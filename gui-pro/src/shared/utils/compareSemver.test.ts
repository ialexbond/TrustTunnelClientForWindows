import { describe, it, expect } from "vitest";
import { compareSemver } from "./compareSemver";

describe("compareSemver (PANEL-04 dedup — one ascending direction)", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.0.31", "1.0.31")).toBe(0);
    expect(compareSemver("2.7.0", "2.7.0")).toBe(0);
  });

  it("returns positive when a > b (ascending convention)", () => {
    expect(compareSemver("1.0.33", "1.0.31")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("returns negative when a < b", () => {
    expect(compareSemver("1.0.31", "1.0.33")).toBeLessThan(0);
    expect(compareSemver("1.9.9", "2.0.0")).toBeLessThan(0);
  });

  it("compares numerically, not lexicographically", () => {
    // "1.10.0" > "1.9.0" numerically — lexicographic would say the opposite.
    expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareSemver("1.9.0", "1.10.0")).toBeLessThan(0);
  });

  it("strips a single leading 'v'", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("v2.0.0", "v1.0.0")).toBeGreaterThan(0);
  });

  it("drops a pre-release suffix after the first '-'", () => {
    // "2.1.1-test" is treated as "2.1.1" — matches former compareVersions/Desc behavior.
    expect(compareSemver("2.1.1-test", "2.1.1")).toBe(0);
    expect(compareSemver("2.1.2-rc1", "2.1.1")).toBeGreaterThan(0);
  });

  it("treats missing trailing segments as 0", () => {
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.1", "1.0")).toBeGreaterThan(0);
    expect(compareSemver("1", "1.0.0")).toBe(0);
  });

  it("treats non-numeric / empty segments as 0", () => {
    expect(compareSemver("", "0.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "")).toBeGreaterThan(0);
  });

  it("is antisymmetric: sign(compareSemver(a,b)) === -sign(compareSemver(b,a))", () => {
    const a = "1.0.33";
    const b = "1.0.31";
    expect(Math.sign(compareSemver(a, b))).toBe(-Math.sign(compareSemver(b, a)));
  });
});
