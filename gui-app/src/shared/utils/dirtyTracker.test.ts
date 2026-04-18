import { describe, it, expect } from "vitest";
import { isDirty, createSnapshot } from "./dirtyTracker";

describe("isDirty", () => {
  it("returns false when objects are identical", () => {
    const snap = { anti_dpi: true, custom_sni: "", skip_verification: false };
    expect(isDirty(snap, { ...snap })).toBe(false);
  });

  it("returns true when a boolean field changes", () => {
    expect(isDirty({ anti_dpi: true }, { anti_dpi: false })).toBe(true);
  });

  it("returns false when boolean field is unchanged", () => {
    expect(isDirty({ anti_dpi: false }, { anti_dpi: false })).toBe(false);
  });

  it("returns true when a string field changes", () => {
    expect(isDirty({ custom_sni: "" }, { custom_sni: "example.com" })).toBe(true);
  });

  it("returns false when a string field is unchanged", () => {
    expect(isDirty({ custom_sni: "example.com" }, { custom_sni: "example.com" })).toBe(false);
  });

  it("returns true when array field changes (different values)", () => {
    const initial = { dns_upstreams: ["8.8.8.8"] };
    const current = { dns_upstreams: ["8.8.8.8", "1.1.1.1"] };
    expect(isDirty(initial, current)).toBe(true);
  });

  it("returns false when array field is unchanged", () => {
    const initial = { dns_upstreams: ["8.8.8.8", "1.1.1.1"] };
    const current = { dns_upstreams: ["8.8.8.8", "1.1.1.1"] };
    expect(isDirty(initial, current)).toBe(false);
  });

  it("returns true when array order changes (order-sensitive)", () => {
    const initial = { dns_upstreams: ["8.8.8.8", "1.1.1.1"] };
    const current = { dns_upstreams: ["1.1.1.1", "8.8.8.8"] };
    expect(isDirty(initial, current)).toBe(true);
  });

  it("returns true when field type changes from scalar to array", () => {
    expect(isDirty({ field: "value" }, { field: ["value"] as unknown as string })).toBe(true);
  });

  it("returns true when a field present in initial is absent in current", () => {
    expect(isDirty({ a: "x", b: "y" }, { a: "x" })).toBe(true);
  });

  it("returns true when a field present in current is absent in initial", () => {
    expect(isDirty({ a: "x" }, { a: "x", b: "y" })).toBe(true);
  });

  it("returns false for empty objects", () => {
    expect(isDirty({}, {})).toBe(false);
  });

  it("handles null values correctly", () => {
    expect(isDirty({ cert: null }, { cert: null })).toBe(false);
    expect(isDirty({ cert: null }, { cert: "abc" })).toBe(true);
  });

  it("returns true when multiple fields change", () => {
    const initial = { anti_dpi: true, custom_sni: "", skip_verification: false };
    const current = { anti_dpi: false, custom_sni: "sni.com", skip_verification: false };
    expect(isDirty(initial, current)).toBe(true);
  });
});

describe("createSnapshot", () => {
  it("copies all defined fields", () => {
    const snap = createSnapshot({ a: "x", b: true, c: ["1", "2"] });
    expect(snap).toEqual({ a: "x", b: true, c: ["1", "2"] });
  });

  it("omits undefined values", () => {
    const snap = createSnapshot({ a: "x", b: undefined });
    expect(Object.keys(snap)).toEqual(["a"]);
    expect(snap.a).toBe("x");
    expect("b" in snap).toBe(false);
  });

  it("keeps null values", () => {
    const snap = createSnapshot({ a: null });
    expect(snap.a).toBeNull();
  });

  it("returns empty object for all-undefined input", () => {
    const snap = createSnapshot({ a: undefined, b: undefined });
    expect(snap).toEqual({});
  });
});
