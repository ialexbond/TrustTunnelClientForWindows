import { describe, it, expect } from "vitest";
import { buildVersionLabel } from "./buildVersionLabel";

describe("buildVersionLabel (T-13 build hash)", () => {
  it("appends -<hash> when a build hash is present", () => {
    // Simulates a build where VITE_BUILD_HASH was injected → __BUILD_HASH__ set.
    expect(buildVersionLabel("3.0.0", "a3f9k2")).toBe("3.0.0-a3f9k2");
  });

  it("renders the bare version when the build hash is empty (graceful fallback)", () => {
    // Simulates a plain dev run where no hash was injected (__BUILD_HASH__ === "").
    expect(buildVersionLabel("3.0.0", "")).toBe("3.0.0");
  });

  it("does not mutate the version value itself (version is FROZEN)", () => {
    expect(buildVersionLabel("2.7.0", "")).toBe("2.7.0");
    expect(buildVersionLabel("2.7.0", "x1y2z3")).toBe("2.7.0-x1y2z3");
  });
});
