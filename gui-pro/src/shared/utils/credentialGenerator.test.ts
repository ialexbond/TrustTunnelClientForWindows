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

    it("produces unique results across 100 calls (collision < 5%)", () => {
      const results = new Set<string>();
      for (let i = 0; i < 100; i++) {
        results.add(generateUsername());
      }
      // At least 95 unique out of 100
      expect(results.size).toBeGreaterThanOrEqual(95);
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
