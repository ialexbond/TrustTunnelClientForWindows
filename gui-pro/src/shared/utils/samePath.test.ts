import { describe, it, expect } from "vitest";
import { samePath, normalizePath } from "./samePath";

describe("samePath", () => {
  it("matches byte-identical paths", () => {
    expect(samePath("C:/app/x.toml", "C:/app/x.toml")).toBe(true);
  });

  it("matches across separator style (backslash vs forward slash)", () => {
    // The exact divergence behind 11-UAT gaps B/C: manifest stores forward slashes,
    // localStorage tt_config_path was written with Windows backslashes.
    expect(samePath("C:\\app\\TrustTunnel_swift-fox.toml", "C:/app/TrustTunnel_swift-fox.toml")).toBe(true);
  });

  it("matches across drive-letter / general casing", () => {
    expect(samePath("c:/App/X.TOML", "C:/app/x.toml")).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(samePath("  C:/app/x.toml  ", "C:/app/x.toml")).toBe(true);
  });

  it("does NOT match different files", () => {
    expect(samePath("C:/app/a.toml", "C:/app/b.toml")).toBe(false);
  });

  it("treats empty / nullish inputs as no match (never collapses an unknown active path)", () => {
    expect(samePath("", "C:/app/x.toml")).toBe(false);
    expect(samePath("C:/app/x.toml", "")).toBe(false);
    expect(samePath(undefined, "C:/app/x.toml")).toBe(false);
    expect(samePath("C:/app/x.toml", null)).toBe(false);
    expect(samePath(undefined, undefined)).toBe(false);
  });

  it("normalizePath lowercases, unifies separators, and trims", () => {
    expect(normalizePath("  C:\\App\\X.toml ")).toBe("c:/app/x.toml");
  });
});
