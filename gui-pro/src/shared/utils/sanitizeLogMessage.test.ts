import { describe, it, expect } from "vitest";
import { sanitizeLogMessage, MAX_LOG_LEN } from "./sanitizeLogMessage";

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
