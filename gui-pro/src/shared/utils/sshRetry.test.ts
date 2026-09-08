import { describe, it, expect, vi } from "vitest";
import {
  classifySshFailure,
  sshErrorCode,
  retryOnSshTransport,
  type SshFailureClass,
} from "./sshRetry";

// ═══════════════════════════════════════════════════════
// G-32-12 — an SSH session must survive the tunnel coming up
//
// The measured race (UAT 2026-09-08, build h2vn6t): the panel opens its SSH
// session at 10:57:58.326 and auto-connect rewrites the routing table at
// 10:58:00.384 — under that session. The transport dies mid-flight; the
// server never refused anything.
//
// The contract these tests pin:
//   1. a REFUSAL (wrong password, rejected key, refused authentication) is
//      never retried — one attempt, surfaced immediately. Retrying an
//      authentication failure is how fail2ban bans the user from their own
//      server, and this app installs fail2ban itself.
//   2. a TRANSPORT failure (the pipe broke) is retried, bounded.
//   3. every retry and every refusal is reportable — the caller gets a
//      callback carrying a code that is provably not credential-shaped.
// ═══════════════════════════════════════════════════════

// ─── Classification ──────────────────────────────────

describe("classifySshFailure", () => {
  // The server said "no". These are the codes ssh_connect returns when
  // authentication was REFUSED, plus the deterministic local/validation
  // failures — none of them can be cured by trying again.
  const refusals: string[] = [
    "SSH_AUTH_FAILED",
    "SSH_PASSWORD_REJECTED",
    "SSH_KEY_REJECTED",
    "SSH_KEY_LOAD_FAILED|/home/u/.ssh/id_ed25519|bad passphrase",
    "SSH_KEY_REENTER_REQUIRED|file",
    "SSH_KEY_REENTER_REQUIRED|pasted",
    "SSH_KEY_REENTER_REQUIRED|missing",
    "SSH_INVALID_HOST|SSH host contains invalid characters",
    "SSH_INVALID_USER|bad",
    "SSH_INVALID_AUTH_METHOD|telepathy",
    "SSH_DEPLOY_CANCELLED",
  ];

  it.each(refusals)("classifies %s as a refusal (never retried)", (raw) => {
    expect(classifySshFailure(raw)).toBe<SshFailureClass>("refusal");
  });

  // The pipe broke. `SSH_AUTH_ERROR` / `SSH_KEY_AUTH_ERROR` belong HERE and not
  // above: ssh/mod.rs emits them when the `authenticate_*` CALL itself errors —
  // i.e. the exchange was cut off — whereas an actual refusal comes back as
  // SSH_AUTH_FAILED / SSH_PASSWORD_REJECTED / SSH_KEY_REJECTED. A route flip
  // mid-handshake produces the former, and treating it as a refusal would make
  // the panel show "wrong password" for a working password.
  const transports: string[] = [
    "SSH_AUTH_ERROR|Disconnected",
    "SSH_KEY_AUTH_ERROR|connection reset by peer",
    "SSH_CONNECT_FAILED|broken pipe",
    "SSH_TIMEOUT|10.0.0.1",
    "SSH_CHANNEL_FAILED|Disconnected",
    "SSH_EXEC_FAILED|ChannelOpenFailure(ConnectFailed)",
    "SSH_NETWORK_UNREACHABLE|10.0.0.1",
    "SSH_CONNECTION_REFUSED|10.0.0.1|22",
    "SSH_DNS_FAILED|example.org",
    "SSH_TLS_HANDSHAKE_FAILED|example.org",
  ];

  it.each(transports)("classifies %s as transport (retryable)", (raw) => {
    expect(classifySshFailure(raw)).toBe<SshFailureClass>("transport");
  });

  // A changed host key is deterministic AND security-sensitive: it has its own
  // reset flow and must never be silently retried. Both spellings, both cases —
  // russh occasionally lowercases the key variant (WR-04).
  it.each([
    "SSH_HOST_KEY_CHANGED",
    "SSH_CONNECT_FAILED|Unknown server key",
    "SSH_CONNECT_FAILED|unknown server key",
    "HOST_KEY_CHANGED",
  ])("classifies %s as hostKey (never retried)", (raw) => {
    expect(classifySshFailure(raw)).toBe<SshFailureClass>("hostKey");
  });

  // Anything outside the known vocabulary is "unknown", NOT "transport": the
  // caller decides. The connect-time probe opts into retrying unknowns (the
  // cold-start race surfaces under many russh wordings); the pooled read probes
  // do not (SSH_READ_CONFIG_FAILED is a deterministic server-side condition and
  // retrying it just costs seconds).
  it.each([
    "SSH_READ_CONFIG_FAILED",
    "SSH_ENDPOINT_NOT_INSTALLED|/opt/trusttunnel/bin",
    "Unknown error",
    "some raw russh prose nobody coded",
    "",
  ])("classifies %s as unknown (caller's policy)", (raw) => {
    expect(classifySshFailure(raw)).toBe<SshFailureClass>("unknown");
  });
});

// ─── Code extraction is credential-safe by construction (D-29) ───

describe("sshErrorCode", () => {
  it("returns the leading machine code of a coded error", () => {
    expect(sshErrorCode("SSH_CHANNEL_FAILED|Disconnected")).toBe("SSH_CHANNEL_FAILED");
    expect(sshErrorCode("SSH_AUTH_FAILED")).toBe("SSH_AUTH_FAILED");
    expect(sshErrorCode("GEOIP_TIMEOUT")).toBe("GEOIP_TIMEOUT");
  });

  // D-29 is absolute: nothing this function returns may ever reach a log sink
  // carrying credential material. It is whitelisted to the SSH_/GEOIP_ code
  // vocabulary rather than "whatever came before the first pipe", so the
  // guarantee holds by CONSTRUCTION and not by hoping the caller was careful.
  it.each([
    "hunter2",
    "P@ssw0rd-Recognizable",
    "SUPERSECRET",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "correct horse battery staple|SSH_AUTH_FAILED",
    "SSH_", // prefix alone is not a code
  ])("collapses non-vocabulary input %s to UNCODED", (raw) => {
    expect(sshErrorCode(raw)).toBe("UNCODED");
  });

  it("never echoes credential-shaped input back to the caller", () => {
    const secret = "S3cr3t-P@ssw0rd-Recognizable";
    expect(sshErrorCode(secret)).not.toContain(secret);
    expect(sshErrorCode(`${secret}|detail`)).not.toContain(secret);
  });
});

// ─── The bounded retry ───────────────────────────────

describe("retryOnSshTransport", () => {
  it("returns the value without retrying when the operation succeeds", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    await expect(retryOnSshTransport(op, { attempts: 3, delayMs: 0 })).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries a transport failure and resolves once the transport recovers", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce("SSH_AUTH_ERROR|Disconnected")
      .mockResolvedValueOnce("ok");
    const onTransientFailure = vi.fn();

    await expect(
      retryOnSshTransport(op, { attempts: 3, delayMs: 0, onTransientFailure }),
    ).resolves.toBe("ok");

    expect(op).toHaveBeenCalledTimes(2);
    expect(onTransientFailure).toHaveBeenCalledTimes(1);
    expect(onTransientFailure).toHaveBeenCalledWith({
      attempt: 1,
      attempts: 3,
      code: "SSH_AUTH_ERROR",
    });
  });

  // THE core contract of G-32-12. A wrong password must cost the server exactly
  // one authentication attempt, not three.
  it("does NOT retry a refused authentication — one attempt, surfaced immediately", async () => {
    const op = vi.fn().mockRejectedValue("SSH_PASSWORD_REJECTED");
    const onRefusal = vi.fn();
    const onTransientFailure = vi.fn();

    await expect(
      retryOnSshTransport(op, {
        attempts: 3,
        delayMs: 60_000, // would hang the test if a retry were ever scheduled
        onRefusal,
        onTransientFailure,
      }),
    ).rejects.toBe("SSH_PASSWORD_REJECTED");

    expect(op).toHaveBeenCalledTimes(1);
    expect(onTransientFailure).not.toHaveBeenCalled();
    expect(onRefusal).toHaveBeenCalledWith({
      code: "SSH_PASSWORD_REJECTED",
      failureClass: "refusal",
    });
  });

  it.each(["SSH_AUTH_FAILED", "SSH_KEY_REJECTED", "SSH_KEY_REENTER_REQUIRED|file"])(
    "does NOT retry %s",
    async (raw) => {
      const op = vi.fn().mockRejectedValue(raw);
      await expect(
        retryOnSshTransport(op, { attempts: 3, delayMs: 60_000 }),
      ).rejects.toBe(raw);
      expect(op).toHaveBeenCalledTimes(1);
    },
  );

  it("does NOT retry a changed host key", async () => {
    const op = vi.fn().mockRejectedValue("SSH_CONNECT_FAILED|Unknown server key");
    const onRefusal = vi.fn();

    await expect(
      retryOnSshTransport(op, { attempts: 3, delayMs: 60_000, onRefusal }),
    ).rejects.toBe("SSH_CONNECT_FAILED|Unknown server key");

    expect(op).toHaveBeenCalledTimes(1);
    expect(onRefusal).toHaveBeenCalledWith({
      code: "SSH_CONNECT_FAILED",
      failureClass: "hostKey",
    });
  });

  // Bounded: a transport failure that never clears must give up, not loop.
  it("gives up after exactly `attempts` tries and rethrows the last error", async () => {
    const op = vi.fn().mockRejectedValue("SSH_CHANNEL_FAILED|Disconnected");
    const onTransientFailure = vi.fn();

    await expect(
      retryOnSshTransport(op, { attempts: 3, delayMs: 0, onTransientFailure }),
    ).rejects.toBe("SSH_CHANNEL_FAILED|Disconnected");

    expect(op).toHaveBeenCalledTimes(3);
    // Reported once per retry that actually followed — not on the give-up.
    expect(onTransientFailure).toHaveBeenCalledTimes(2);
  });

  it("retries an unknown failure only when the caller opts in", async () => {
    const opting = vi.fn().mockRejectedValue("some raw russh prose nobody coded");
    await expect(
      retryOnSshTransport(opting, { attempts: 3, delayMs: 0, retryUnknown: true }),
    ).rejects.toBe("some raw russh prose nobody coded");
    expect(opting).toHaveBeenCalledTimes(3);

    const strict = vi.fn().mockRejectedValue("SSH_READ_CONFIG_FAILED");
    await expect(
      retryOnSshTransport(strict, { attempts: 3, delayMs: 60_000, retryUnknown: false }),
    ).rejects.toBe("SSH_READ_CONFIG_FAILED");
    expect(strict).toHaveBeenCalledTimes(1);
  });

  it("treats attempts < 1 as a single attempt rather than looping or skipping the call", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    await expect(retryOnSshTransport(op, { attempts: 0, delayMs: 0 })).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  // D-29 at the boundary that matters: whatever the caller is handed for
  // logging can never carry the credential, even when the raw error does.
  it("hands the caller only a vocabulary code, never the raw error text", async () => {
    const secret = "S3cr3t-P@ssw0rd-Recognizable";
    const op = vi.fn().mockRejectedValue(`${secret} was rejected by the server`);
    const seen: string[] = [];

    await expect(
      retryOnSshTransport(op, {
        attempts: 2,
        delayMs: 0,
        retryUnknown: true,
        onTransientFailure: ({ code }) => seen.push(code),
        onRefusal: ({ code }) => seen.push(code),
      }),
    ).rejects.toBeTruthy();

    expect(seen.length).toBeGreaterThan(0);
    for (const code of seen) {
      expect(code).toBe("UNCODED");
      expect(code).not.toContain(secret);
    }
  });
});
