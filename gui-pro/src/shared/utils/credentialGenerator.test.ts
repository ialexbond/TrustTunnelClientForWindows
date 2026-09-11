import { describe, it, expect, vi } from "vitest";
import { generateUsername, generatePassword } from "./credentialGenerator";

describe("credentialGenerator", () => {
  describe("generateUsername", () => {
    it("matches adjective-noun format with optional 2-digit suffix", () => {
      for (let i = 0; i < 50; i++) {
        const username = generateUsername();
        expect(username).toMatch(/^[a-zA-Z]+-[a-zA-Z]+([0-9]{2})?$/);
      }
    });

    /**
     * Guards against a DEGENERATE generator (a stuck index, a collapsed charset), not against
     * ordinary birthday collisions.
     *
     * The old bound was ≥95 unique out of 100 and flaked in CI. The maths says why. Half the draws
     * get no numeric suffix, so ~50 of them land in a space of 30 adjectives × 30 nouns = 900:
     * expected collisions there are C(50,2)/900 ≈ 1.4, and the suffixed half (900 × 90 = 81 000)
     * contributes almost nothing. So the honest expectation is ~98.6 unique with a standard
     * deviation near 1.2 — and 95 sits barely 3σ out, which a suite that runs many times a day WILL
     * hit.
     *
     * 90 is ~7σ from the mean: unreachable by chance, while any real degeneracy (a generator stuck
     * on one adjective collapses the space to 30 × 91) lands far below it. Do not "tighten" this
     * back to 95 — that number was never a property of the generator, only of a lucky run.
     */
    it("produces near-unique results across 100 calls (catches a degenerate generator)", () => {
      const results = new Set<string>();
      for (let i = 0; i < 100; i++) {
        results.add(generateUsername());
      }
      expect(results.size).toBeGreaterThanOrEqual(90);
    });

    it("does NOT use Math.random", () => {
      const spy = vi.spyOn(Math, "random");
      for (let i = 0; i < 10; i++) {
        generateUsername();
      }
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("generatePassword", () => {
    it("returns exactly 16 characters", () => {
      const password = generatePassword();
      expect(password).toHaveLength(16);
    });

    it("only contains chars from allowed charset", () => {
      const allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
      for (let i = 0; i < 50; i++) {
        const password = generatePassword();
        for (const ch of password) {
          expect(allowed).toContain(ch);
        }
      }
    });

    it("produces unique results across 100 calls", () => {
      const results = new Set<string>();
      for (let i = 0; i < 100; i++) {
        results.add(generatePassword());
      }
      expect(results.size).toBe(100);
    });
  });
});
