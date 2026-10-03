import { describe, it, expect } from "vitest";
import { buildConfigFileName } from "./configFileName";

describe("buildConfigFileName (06-uat fix 14)", () => {
  it("defaults to TrustTunnel_<username>.toml with no country", () => {
    expect(buildConfigFileName("keen-mole17")).toBe("TrustTunnel_keen-mole17.toml");
  });

  it("adds an UPPERCASE country prefix when a code is provided", () => {
    expect(buildConfigFileName("keen-mole17", "DE")).toBe(
      "DE_TrustTunnel_keen-mole17.toml",
    );
  });

  it("uppercases a lowercase country code", () => {
    expect(buildConfigFileName("alice", "us")).toBe("US_TrustTunnel_alice.toml");
  });

  it("omits the prefix gracefully for an empty / nullish country", () => {
    expect(buildConfigFileName("bob", "")).toBe("TrustTunnel_bob.toml");
    expect(buildConfigFileName("bob", null)).toBe("TrustTunnel_bob.toml");
    expect(buildConfigFileName("bob", undefined)).toBe("TrustTunnel_bob.toml");
  });

  it("omits the prefix for an implausible country value (not a 2-3 letter code)", () => {
    expect(buildConfigFileName("bob", "Germany")).toBe("TrustTunnel_bob.toml");
    expect(buildConfigFileName("bob", "1")).toBe("TrustTunnel_bob.toml");
  });

  it("sanitizes filename-unsafe characters out of the username", () => {
    // Path separators / spaces / quotes must never reach the produced name (dots are a
    // legitimate filename character and are preserved).
    const name = buildConfigFileName("../../etc/passwd");
    expect(name).not.toMatch(/[/\\]/); // no path separators survive
    expect(name).toBe("TrustTunnel_....etcpasswd.toml");
    expect(buildConfigFileName('a b"c')).toBe("TrustTunnel_abc.toml");
  });

  it("falls back to a safe generic stem when the username sanitizes to empty", () => {
    expect(buildConfigFileName("///")).toBe("TrustTunnel_client.toml");
    expect(buildConfigFileName("", "DE")).toBe("DE_TrustTunnel_client.toml");
  });

  it("trims surrounding whitespace from the username", () => {
    expect(buildConfigFileName("  alice  ")).toBe("TrustTunnel_alice.toml");
  });
});
