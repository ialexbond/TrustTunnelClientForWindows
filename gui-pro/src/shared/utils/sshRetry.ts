import { formatError } from "./formatError";

/**
 * G-32-12 — classify an SSH failure so an in-flight session can survive the
 * transport being re-routed, WITHOUT ever re-offering a rejected credential.
 *
 * Why this exists (UAT 2026-09-08, build h2vn6t). Fixing auto-connect (G-32-9)
 * created an overlap that had never happened before: the control panel opens its
 * SSH session ~2 s before the tunnel comes up and rewrites the routing table.
 * The session's transport dies under it. Owner's ruling, verbatim: «SSH-сессия
 * должна пережить подключение VPN, то есть она не должна там умирать, иначе это
 * странно».
 *
 * The dangerous half of "just retry it" is authentication. This app installs and
 * manages fail2ban on the very server it is talking to (`security_start_fail2ban`),
 * and the panel auto-loads on launch — so a blanket retry of a wrong password is a
 * mechanism for banning the user from their own server. Hence a classifier and not
 * a bare loop.
 *
 * The four classes map onto the error vocabulary `ssh/mod.rs` actually emits:
 *
 *  • `refusal`   — the server (or our own validator) said NO, deterministically.
 *                  SSH_AUTH_FAILED / SSH_PASSWORD_REJECTED / SSH_KEY_REJECTED are
 *                  returned when `authenticate_*` completed and came back negative.
 *                  Never retried, ever.
 *  • `hostKey`   — deterministic AND security-sensitive; it has its own reset flow
 *                  in useServerState's outer catch. Never silently retried.
 *  • `transport` — the pipe broke. NOTE that SSH_AUTH_ERROR / SSH_KEY_AUTH_ERROR
 *                  live here, not under `refusal`: mod.rs emits those when the
 *                  `authenticate_*` CALL ITSELF errored, i.e. the exchange was cut
 *                  off mid-flight. That is precisely the signature of a route flip
 *                  during the handshake, and misfiling it as a refusal would show
 *                  «неверный пароль» for a password that is perfectly correct —
 *                  the exact G-07 false positive this codebase has hit before.
 *  • `unknown`   — outside the vocabulary. Deliberately NOT folded into
 *                  `transport`, because the right policy differs per caller:
 *                  the connect-time probe retries unknowns (the cold-start race
 *                  surfaces under many russh wordings), while the pooled read
 *                  probes must not (SSH_READ_CONFIG_FAILED is a deterministic
 *                  server-side condition — retrying it only burns seconds).
 */
export type SshFailureClass = "refusal" | "hostKey" | "transport" | "unknown";

/** The server refused, or our own validator did. Trying again cannot help. */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  "SSH_AUTH_FAILED",
  "SSH_PASSWORD_REJECTED",
  "SSH_KEY_REJECTED",
  "SSH_KEY_LOAD_FAILED",
  "SSH_KEY_REENTER_REQUIRED",
  "SSH_INVALID_HOST",
  "SSH_INVALID_USER",
  "SSH_INVALID_AUTH_METHOD",
  // A cancel is a deliberate human decision, not a failure to recover from.
  "SSH_DEPLOY_CANCELLED",
]);

/** The pipe broke. Re-running the operation on a fresh connection can succeed. */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "SSH_AUTH_ERROR",
  "SSH_KEY_AUTH_ERROR",
  "SSH_CONNECT_FAILED",
  "SSH_TIMEOUT",
  "SSH_CHANNEL_FAILED",
  "SSH_EXEC_FAILED",
  "SSH_NETWORK_UNREACHABLE",
  "SSH_CONNECTION_REFUSED",
  "SSH_DNS_FAILED",
  "SSH_TLS_HANDSHAKE_FAILED",
]);

/**
 * The machine code at the head of a backend error, or `"UNCODED"`.
 *
 * D-29 is absolute, and this is the function whose output reaches the activity
 * log. It is therefore whitelisted to the SSH_/GEOIP_ vocabulary instead of
 * returning "whatever preceded the first pipe": the no-credential-in-the-log
 * guarantee then holds BY CONSTRUCTION, not by trusting every future caller to
 * remember. Anything that is not a code collapses to `UNCODED`, which is still a
 * useful thing to read in a log ("something failed and it wasn't one of ours").
 */
export function sshErrorCode(raw: unknown): string {
  const head = String(formatError(raw)).split("|")[0]?.trim() ?? "";
  return /^(?:SSH|GEOIP)_[A-Z0-9][A-Z0-9_]{0,47}$/.test(head) ? head : "UNCODED";
}

/**
 * Classify a raw backend error string. Classify on the RAW text, never on the
 * translated one: `translateSshError` reclassifies several transport wordings as
 * «Неверный SSH логин или пароль» (G-07), so classifying downstream of it would
 * turn a recoverable route flip into a permanent fake auth error.
 */
export function classifySshFailure(raw: unknown): SshFailureClass {
  const text = formatError(raw);
  // Host key first: it can arrive both as its own code and as detail inside
  // SSH_CONNECT_FAILED. Case-insensitive — russh occasionally lowercases the key
  // variant in its message (WR-04).
  const lower = text.toLowerCase();
  if (lower.includes("host_key_changed") || lower.includes("unknown server key")) {
    return "hostKey";
  }
  const code = sshErrorCode(text);
  if (REFUSAL_CODES.has(code)) return "refusal";
  if (TRANSPORT_CODES.has(code)) return "transport";
  return "unknown";
}

export interface SshRetryReport {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Total attempt budget this call was given. */
  attempts: number;
  /** Vocabulary code only — never raw error text (D-29). */
  code: string;
}

export interface SshRefusalReport {
  /** Vocabulary code only — never raw error text (D-29). */
  code: string;
  failureClass: Exclude<SshFailureClass, "transport">;
}

export interface SshRetryOptions {
  /** Hard upper bound on calls to `op`. Values < 1 are treated as 1. */
  attempts: number;
  /** Pause between attempts, in ms. */
  delayMs: number;
  /**
   * Whether a failure OUTSIDE the known vocabulary should be retried. Defaults
   * to `false` — the strict reading. The connect-time probe passes `true`
   * deliberately; see the note on `SshFailureClass`.
   */
  retryUnknown?: boolean;
  /** Called once per retry that actually follows — not on the final give-up. */
  onTransientFailure?: (report: SshRetryReport) => void;
  /** Called once when a refusal / host-key change short-circuits the budget. */
  onRefusal?: (report: SshRefusalReport) => void;
}

/**
 * Run `op`, retrying ONLY failures whose transport broke, at most `attempts`
 * times, rethrowing the original error untouched.
 *
 * The loop is a bounded `for` — there is no path on which it runs forever, and a
 * refusal exits on the first attempt without ever reaching the delay.
 */
export async function retryOnSshTransport<T>(
  op: () => Promise<T>,
  options: SshRetryOptions,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts));
  const retryUnknown = options.retryUnknown ?? false;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      const failureClass = classifySshFailure(err);
      const code = sshErrorCode(err);

      const retryable =
        failureClass === "transport" || (failureClass === "unknown" && retryUnknown);

      if (!retryable) {
        // A refusal never gets a second offer of the credential. Surface it now.
        // `retryable` is a const alias of the guard above, so TS has already
        // narrowed `failureClass` out of "transport" here — no cast needed, and
        // no dead defensive branch pretending otherwise.
        options.onRefusal?.({ code, failureClass });
        throw err;
      }

      if (attempt < attempts) {
        options.onTransientFailure?.({ attempt, attempts, code });
        if (options.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
      }
    }
  }
  throw lastError;
}
