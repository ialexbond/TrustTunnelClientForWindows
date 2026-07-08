import type { LogEntry } from "../types";
import type { i18n as I18nType } from "i18next";

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
// disconnect-failed.
export const REASON_CODE_I18N: Record<string, string> = {
  "connect-timeout": "errors.connect_timeout",
  "reconnect-gave-up": "errors.reconnect_gave_up",
  "recovery-timeout": "errors.recovery_timeout",
  "no-internet": "errors.no_internet",
  "sidecar-exit": "errors.sidecar_exit",
  // AUDIT-2026-06-11 #20: emitted by vpn_disconnect when BOTH kill paths fail — the sidecar may
  // still be alive holding the killswitch, so the message must tell the user honestly instead of
  // leaking the raw token.
  "disconnect-failed": "errors.disconnect_failed",
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
