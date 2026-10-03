import type { LogEntry } from "../types";
import type { i18n as I18nType } from "i18next";
import { formatError } from "../utils/formatError";

// Phase 17 (17-05, CA-1) — the ONE shared helper module for the per-signal VPN event hooks.
//
// Before the decomposition, `localizeError` and `traceLog` were inline closures duplicated
// inside the 604-line `useVpnEvents`. Splitting the 5 listeners into per-signal hooks means
// several of them need the SAME two helpers, so they live here as small factories the wiring
// layer instantiates once and passes down. Behavior is byte-identical to the old inline
// versions — this is relocation, not a rewrite.

// ─── Reason-code → i18n key maps (D-29 / D-09) ───
//
// The backend sets terminal Errors with a STABLE ASCII reason code, never a user-facing string
// (CLAUDE.md i18n rule). We localize the code HERE so the user sees the Russian (primary) /
// English (mirror) message, never the raw token. Any error that is NOT a known code passes
// through unchanged (older sanitized backend messages still render verbatim).
//
// Keep this list in sync with the backend reason codes (status-lifecycle.md §Reason-коды):
// connect-timeout / reconnect-gave-up / recovery-timeout / no-internet / sidecar-exit /
// disconnect-failed / failover-exhausted.
export const REASON_CODE_I18N: Record<string, string> = {
  "connect-timeout": "errors.connect_timeout",
  "reconnect-gave-up": "errors.reconnect_gave_up",
  // Phase 28 (28-03, D-05): the failover walk made ONE pass over every participating server and
  // none of them answered. Deliberately its OWN key, never a reuse of `reconnect-gave-up`: «этот
  // сервер не вернулся» and «ни один из ваших серверов не ответил» are different facts, and 28-02
  // minted `failover-exhausted` as a distinct code precisely so they cannot collapse into one
  // message. The retry affordance is the app's EXISTING terminal-error retry — no new control.
  "failover-exhausted": "errors.failover_exhausted",
  "recovery-timeout": "errors.recovery_timeout",
  "no-internet": "errors.no_internet",
  "sidecar-exit": "errors.sidecar_exit",
  // AUDIT-2026-06-11 #20: emitted by vpn_disconnect when BOTH kill paths fail — the sidecar may
  // still be alive holding the killswitch, so the message must tell the user honestly instead of
  // leaking the raw token.
  "disconnect-failed": "errors.disconnect_failed",
  // D-02 (30.1 milestone review, blocker 2): `routing_rules.json` exists but cannot be parsed, so
  // the backend REFUSED the connect rather than proceeding with an empty rule set and reporting
  // «Подключено». The message names the file as the cause and points at the Routing tab, because
  // that is where the recovery lives — the reset belongs beside the rules it destroys, not on this
  // surface. Following Phase 28 D-05, no new control is minted here.
  //
  // The serde error is deliberately NOT interpolated: it is English, unbounded, and can quote the
  // file's own bytes. The token is the whole payload (D-09/D-29).
  "routing-rules-unreadable": "errors.routing_rules_unreadable",
  // 30.1 regression defect 1: the CA-2 path-confinement guard refused the connect because the
  // `.toml` is not inside the folder the app keeps its configs in. The backend never contacted
  // the server, so the generic «Не удалось выполнить подключение к серверу» this used to fall
  // back to named the wrong culprit entirely. The message names the FILE and tells the user the
  // one thing that fixes it (add the server again), because there is no control that can move a
  // file the app is forbidden to touch.
  "config-outside-data-dir": "errors.config_outside_data_dir",
};

// F16 (14-UAT round 2): the C++ sidecar emits a handful of FIXED English phrases on the
// vpn-status error payload (fatal_marker_error / config_parse_error in
// src-tauri/src/sidecar.rs). They are stable DERIVED phrases (D-29-safe, never raw log text) but
// are NOT ASCII reason codes, so localizeError used to pass them straight through — leaking
// English «Server refused the connection»/«Authorization failed» into the Russian UI (both the
// snackbar and the StatusPanel banner). Map each to its existing localized key. Keep this
// byte-for-byte in sync with sidecar.rs; if a phrase drifts it silently degrades to passthrough
// (today's behavior), never a crash.
export const CORE_MESSAGE_I18N: Record<string, string> = {
  "Authorization failed": "errors.auth_required",
  "VPN adapter creation failed": "errors.wintun_missing",
  "Failed to start VPN tunnel": "errors.listener_failed",
  "Server refused the connection": "errors.connection_refused",
  "Configuration parse error. Check your config file.": "errors.config_parse_error",
};

/**
 * Build the `localizeError` helper: map a stable backend reason CODE (or a fixed core phrase)
 * to a localized display string; anything unmapped passes through unchanged (SAFETY-03 seam).
 * A `null`/`undefined` error stays `null`.
 */
export function makeLocalizeError(i18n: I18nType) {
  return (error: string | null | undefined): string | null => {
    if (!error) return error ?? null;
    const key = REASON_CODE_I18N[error] ?? CORE_MESSAGE_I18N[error];
    return key ? i18n.t(key) : error;
  };
}

/**
 * Localize a REJECTED VPN command (the `invoke(...)` catch channel), not a status event.
 *
 * 30.1 regression defect 1 — the second half of «the refusal speaks Russian». A refused connect
 * reaches the user twice: once as a terminal `Error` status carrying a reason code (localized by
 * `makeLocalizeError` above) and once as the rejected promise of `invoke("vpn_connect")`, whose
 * value every catch block funnelled straight into `setError(formatError(e))`. The backend now
 * returns the SAME reason code on both channels, so both must run through the same map — a fix
 * applied to only one of them shows the Russian sentence in the snackbar and the raw ASCII token
 * in the red banner, which is worse than the English sentence it replaced.
 *
 * `unknown` in, because catch blocks receive `unknown`; `formatError` does the Error/string
 * unwrapping and guarantees a string comes out. Anything unmapped passes through UNCHANGED —
 * the same SAFETY-03 seam the status channel has: older sanitized backend messages, SSH
 * sentences and plugin errors keep rendering as they do today.
 */
export function localizeVpnError(error: unknown, i18n: I18nType): string {
  const raw = formatError(error);
  const key = REASON_CODE_I18N[raw] ?? CORE_MESSAGE_I18N[raw];
  return key ? i18n.t(key) : raw;
}

/**
 * Build the `traceLog` helper: append a `[connectivity] …`-prefixed info line to the Log Panel
 * buffer (capped at 500 lines). Timestamped HH:MM:SS in local time, identical to the old inline
 * closure. D-29: callers pass only status/error codes here — never a secret.
 */
export function makeTraceLog(setVpnLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>) {
  return (msg: string) => {
    const now = new Date();
    const ts = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
    setVpnLogs((prev) => {
      const next = [...prev, { timestamp: ts, level: "info", message: `[connectivity] ${msg}` }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  };
}
