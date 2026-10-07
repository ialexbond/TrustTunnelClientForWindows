import { describe, it, expect } from "vitest";
import { samePath, normalizePath } from "./samePath";
import identityCases from "./pathIdentityCases.json";

// The shared parity table: `lifecycle::canonical_path_key` (Rust) reads the SAME file in its own
// test module, so the two "same file?" keys cannot drift apart silently.
describe("normalizePath — shared path identity table", () => {
  for (const { input, key } of identityCases as Array<{ input: string; key: string }>) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(key)}`, () => {
      expect(normalizePath(input)).toBe(key);
    });
  }
});

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

  // G-03.1-5: the tray connect door hands the window the extended-length spelling that
  // std::fs::canonicalize produces on Windows, while the manifest card holds the plain one.
  // Both name one file; the comparator has to say so.
  describe("Windows extended-length (verbatim) prefix", () => {
    it("matches a drive path across the verbatim prefix", () => {
      expect(samePath("\\\\?\\C:\\cfg\\b.toml", "C:\\cfg\\b.toml")).toBe(true);
      expect(samePath("C:\\cfg\\b.toml", "\\\\?\\C:\\cfg\\b.toml")).toBe(true);
    });

    it("matches a UNC path across the verbatim UNC prefix", () => {
      expect(samePath("\\\\?\\UNC\\srv\\share\\b.toml", "\\\\srv\\share\\b.toml")).toBe(true);
    });

    it("does NOT match a different file behind the verbatim prefix", () => {
      expect(samePath("\\\\?\\C:\\cfg\\a.toml", "C:\\cfg\\b.toml")).toBe(false);
    });

    it("normalizePath is idempotent on every verbatim spelling", () => {
      for (const raw of [
        "\\\\?\\C:\\cfg\\b.toml",
        "//?/C:/cfg/b.toml",
        "\\\\?\\UNC\\srv\\share\\b.toml",
        "\\\\srv\\share\\b.toml",
        "C:\\cfg\\b.toml",
      ]) {
        const once = normalizePath(raw);
        expect(normalizePath(once)).toBe(once);
      }
    });
  });
});
