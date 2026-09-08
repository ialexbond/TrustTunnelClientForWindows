import { describe, it, expect } from "vitest";
import {
  sanitizeLogMessage,
  redactCredentialShapes,
  redactSecretValue,
  MAX_LOG_LEN,
} from "./sanitizeLogMessage";

/**
 * SAFETY-02 / D-29 (T-04-16): the shared frontend log-sanitizer must strip
 * credential-shaped substrings across multiple secret shapes and truncate.
 * These tests assert the secret VALUE is absent from the output — they fail on
 * a no-op passthrough (the bug we are closing) and pass once redaction runs.
 */
const SECRET = "S3cr3tP@ss";

describe("sanitizeLogMessage", () => {
  it("redacts password = \"...\" (quoted, spaced)", () => {
    const out = sanitizeLogMessage(`password = "${SECRET}"`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("password");
    expect(out).toContain("[redacted]");
  });

  it("redacts password: \"...\" (colon separator)", () => {
    const out = sanitizeLogMessage(`password: "${SECRET}"`);
    expect(out).not.toContain(SECRET);
  });

  it("redacts an unquoted bare password value", () => {
    const out = sanitizeLogMessage(`invalid password=${SECRET} at line 3`);
    expect(out).not.toContain(SECRET);
    // surrounding diagnostic context survives
    expect(out).toContain("at line 3");
  });

  it("redacts mixed-case and prefixed keys (Password, vpnPassword, newPassword)", () => {
    for (const key of ["Password", "vpnPassword", "newPassword", "VpnPassword", "new_password"]) {
      const out = sanitizeLogMessage(`${key}="${SECRET}"`);
      expect(out, `key=${key}`).not.toContain(SECRET);
    }
  });

  it("redacts the `password value: <secret>` Rust-error phrasing", () => {
    // The backend rejects with `invalid password value: <pw>` — there is a
    // descriptive word ("value") between the key and the colon.
    const out = sanitizeLogMessage(`invalid password value: ${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("invalid password");
  });

  it("redacts a JSON payload {\"password\":\"...\"}", () => {
    const out = sanitizeLogMessage(`backend rejected {"password":"${SECRET}"}`);
    expect(out).not.toContain(SECRET);
  });

  it("redacts a single-quoted value", () => {
    const out = sanitizeLogMessage(`password = '${SECRET}'`);
    expect(out).not.toContain(SECRET);
  });

  it("passes a non-secret message through unchanged (under the limit)", () => {
    const msg = "SSH_EXPORT_FAILED exit=1";
    expect(sanitizeLogMessage(msg)).toBe(msg);
  });

  it("truncates an over-long message to MAX_LOG_LEN", () => {
    const long = "x".repeat(MAX_LOG_LEN + 50);
    expect(sanitizeLogMessage(long)).toHaveLength(MAX_LOG_LEN);
  });

  it("redacts even when the secret sits inside an over-long dump (no leak after truncation)", () => {
    // Secret early, then long tail — redaction runs BEFORE truncation, so the
    // value never reaches the (truncated) output regardless of length.
    const dump = `password="${SECRET}" ` + "detail ".repeat(40);
    const out = sanitizeLogMessage(dump);
    expect(out).not.toContain(SECRET);
    expect(out.length).toBeLessThanOrEqual(MAX_LOG_LEN);
  });

  it("returns empty string for empty / non-string input", () => {
    expect(sanitizeLogMessage("")).toBe("");
    // @ts-expect-error — defensive guard against a non-string slipping in
    expect(sanitizeLogMessage(undefined)).toBe("");
  });
});

// ═══════════════════════════════════════════════════════
// G-32-12 — the two halves the panel-load line needs separately
// ═══════════════════════════════════════════════════════

describe("redactCredentialShapes", () => {
  it("redacts the same shapes as sanitizeLogMessage but does NOT truncate", () => {
    const dump = `password="${SECRET}" ` + "detail ".repeat(40);
    const out = redactCredentialShapes(dump);
    expect(out).not.toContain(SECRET);
    // The whole point of splitting it out: panel.load.failed budgets 300 chars
    // for the raw backend error and must not be clamped to 80.
    expect(out.length).toBeGreaterThan(MAX_LOG_LEN);
  });

  it("returns empty string for empty / non-string input", () => {
    expect(redactCredentialShapes("")).toBe("");
    // @ts-expect-error — defensive guard against a non-string slipping in
    expect(redactCredentialShapes(undefined)).toBe("");
  });
});

describe("redactSecretValue", () => {
  it("scrubs a known secret out of free prose that has no key=value shape", () => {
    // The gap identity-redaction exists to close: no `:` or `=`, so the
    // shape-based redactor cannot see it.
    const prose = `authentication with password ${SECRET} failed`;
    expect(redactCredentialShapes(prose)).toContain(SECRET);
    expect(redactSecretValue(prose, SECRET)).not.toContain(SECRET);
  });

  it("scrubs EVERY occurrence, not just the first", () => {
    const out = redactSecretValue(`${SECRET} and again ${SECRET}`, SECRET);
    expect(out).not.toContain(SECRET);
  });

  it("leaks neither the value nor its length", () => {
    const out = redactSecretValue(`tried ${SECRET} once`, SECRET);
    expect(out).not.toContain(SECRET);
    expect(out).toBe("tried [redacted] once");
  });

  it("leaves the message alone when there is no secret to scrub", () => {
    expect(redactSecretValue("SSH_TIMEOUT|10.0.0.1", undefined)).toBe("SSH_TIMEOUT|10.0.0.1");
    expect(redactSecretValue("SSH_TIMEOUT|10.0.0.1", null)).toBe("SSH_TIMEOUT|10.0.0.1");
    expect(redactSecretValue("SSH_TIMEOUT|10.0.0.1", "")).toBe("SSH_TIMEOUT|10.0.0.1");
  });

  it("ignores a too-short secret instead of shredding the message into markers", () => {
    // A 1-2 char "secret" would match almost everywhere; replacing it globally
    // would destroy the log line for no security gain.
    expect(redactSecretValue("SSH_TIMEOUT|10.0.0.1", "1")).toBe("SSH_TIMEOUT|10.0.0.1");
    expect(redactSecretValue("SSH_TIMEOUT|10.0.0.1", "10")).toBe("SSH_TIMEOUT|10.0.0.1");
  });

  it("returns empty string for empty / non-string input", () => {
    expect(redactSecretValue("", SECRET)).toBe("");
    // @ts-expect-error — defensive guard against a non-string slipping in
    expect(redactSecretValue(undefined, SECRET)).toBe("");
  });
});
