import { useRef } from "react";
import type { VpnStatus, LogEntry, ReconnectProgress } from "../types";
import type { i18n as I18nType } from "i18next";
import { makeLocalizeError, makeTraceLog } from "./vpnEventHelpers";
import { useVpnStatusSnapshot } from "./useVpnStatusSnapshot";
import { useVpnStatusListener } from "./useVpnStatusListener";
import { useInternetStatusListener } from "./useInternetStatusListener";
import { useReconnectCompletionListener } from "./useReconnectCompletionListener";
import { useAdapterConflictListener } from "./useAdapterConflictListener";
import { useVpnLogListener } from "./useVpnLogListener";

// Phase 17 (17-05, CA-1) — useVpnEvents was a 604-line god-hook holding 5 event listeners + a
// ~155-line setStatus reducer branching on prev × payload × up-to-4 shared refs, carrying 8+
// layered historical guards (F0/F4/F16/F17/AUDIT-8/B1/B5/F-7). It is now a THIN COMPOSITION of
// per-signal listener hooks over the PURE reduceVpnStatus reducer:
//
//   • useVpnStatusSnapshot         — mount-time check_vpn_status_full snapshot (AUDIT #14 gated)
//   • useVpnStatusListener         — the live `vpn-status` listener (single status owner, D-01)
//   • useInternetStatusListener    — `internet-status` banner routing (typed, PA-1 FE consumer)
//   • useReconnectCompletionListener — the 2nd `vpn-status` listener resolving reconnectResolve
//   • useAdapterConflictListener   — `vpn-adapter-conflict` warning (typed, PA-1 FE consumer)
//   • useVpnLogListener            — `vpn-log` collector + fatal-marker message enrichment
//
// The transition matrix lives in reduceVpnStatus.ts (useVpnStatusReducer), exhaustively unit
// tested so the extraction is provably behavior-identical (17-RESEARCH Pitfall 4: no guard
// broadened, effect ORDER preserved). localizeError/traceLog are ONE shared helper module
// (vpnEventHelpers), built once here and passed to every hook that needs them. No Rust; no C++
// core; status transitions byte-identical to before.

interface UseVpnEventsParams {
  i18n: I18nType;
  setStatus: React.Dispatch<React.SetStateAction<VpnStatus>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setConnectedSince: React.Dispatch<React.SetStateAction<Date | null>>;
  setVpnLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  reconnectResolve: React.MutableRefObject<(() => void) | null>;
  pushSuccess?: (msg: string, type?: "success" | "error") => void;
  // 02-20 status-UX split: per-attempt «Попытка N/N» progress lifted to App state so StatusPanel
  // can render the counter. Optional so existing call sites / tests still type-check.
  setReconnectProgress?: React.Dispatch<React.SetStateAction<ReconnectProgress | null>>;
  // AUDIT-2026-06-11 #8: shared with useVpnActions (owned by App.tsx). True ONLY while a manual
  // «Сохранить и переподключить» (handleReconnect) is actually in flight. The no-dwell guard keys
  // on it so a backend-driven `reconnecting → disconnected` (tray disconnect during auto-reconnect)
  // is no longer swallowed. Optional (absent ref = guard never suppresses, the safe direction).
  manualReconnectActiveRef?: React.MutableRefObject<boolean>;
  // Phase 14 (14-04 / Pitfall 2): a DEFENSIVE backstop the App uses to clear its FE-only
  // `isSwitching` lock. Fired EXACTLY on the terminal `vpn-status` edge — `connected` OR `error`
  // (the two settle outcomes of a switch; a bare `disconnected` is the transient teardown, NOT a
  // settle). Even if a switch promise is abandoned, the terminal edge still releases the lock so
  // the UI can never wedge locked. It lands on the terminal-edge branch — NOT inside/broadening the
  // no-dwell guard (broadening risks eating a REAL terminal disconnect — AUDIT #8 stuck-on-yellow).
  //
  // Phase 14 (FAB-02): the terminal STATUS (`connected` | `error`) is passed so the App can settle
  // its switch on the REAL terminal edge — performSwitch awaits this edge: `connected` → success
  // (stamp last-used), `error` → silent revert.
  onSettled?: (terminalStatus: "connected" | "error") => void;
  // F-7 (Fable-5): set by App when a switch is SUPERSEDED by a genuine user disconnect. Rust writes
  // a connecting → disconnected edge which the snackbar would otherwise map to the RED «Connection
  // failed» — but this was a user-intended disconnect. The connecting→disconnected arm consults +
  // CONSUMES this ref to show the neutral «VPN отключён» instead. Optional.
  switchSupersededRef?: React.MutableRefObject<boolean>;
  // F17 (14-UAT round 2): set by App (mirrors isSwitching) across the WHOLE seamless switch+revert
  // window. While true, BOTH disconnect snackbars (red «Connection failed» + neutral «VPN отключён»)
  // AND the error snackbar are SUPPRESSED so a seamless switch/revert stays calm (amber card +
  // embedded «…восстановлено» banner). Distinct from switchSupersededRef (a one-shot flag); this
  // spans the whole switch. Optional.
  seamlessSwitchActiveRef?: React.MutableRefObject<boolean>;
  // BUG-A2 (17-uat, Fable F1): set by App's handleUserCancel when the user cancels an IN-FLIGHT
  // connect/recovery. The status reducer reads it as the `connectCancelled` guard to route the
  // «Подключение отменено» toast on the terminal `disconnected` edge (flag-based, NOT prev-based —
  // prev is `disconnecting` by then), and consumes it on any terminal edge. Optional.
  connectCancelledRef?: React.MutableRefObject<boolean>;
  // T-34 (Phase 16): lift the log-only `vpn-adapter-conflict` payload into React state so the UI
  // can render the second-VPN warning banner (ErrorBanner variant="warning"). Optional (absent =
  // today's log-only behavior, unchanged).
  setConflict?: (conflict: { adapters: string[]; message: string } | null) => void;
}

export function useVpnEvents({
  i18n,
  setStatus,
  setError,
  setConnectedSince,
  setVpnLogs,
  reconnectResolve,
  pushSuccess,
  setReconnectProgress,
  manualReconnectActiveRef,
  onSettled,
  switchSupersededRef,
  seamlessSwitchActiveRef,
  connectCancelledRef,
  setConflict,
}: UseVpnEventsParams) {
  // AUDIT-2026-06-11 #14: the mount snapshot (check_vpn_status_full) and the live vpn-status
  // listener are independent async channels — the IPC reply can land AFTER a newer live event.
  // The live listener flips this ref first thing; the snapshot applies its result only while the
  // ref is still false. Owned HERE so both hooks share the same instance. The ref never
  // SYNTHESIZES status — it only gates the frontend's own snapshot write (D-01: the vpn-status
  // event stays the owner).
  const sawLiveStatusEventRef = useRef(false);

  // ONE shared helper module (localizeError needs i18n, traceLog needs setVpnLogs) — built once
  // and passed to every per-signal hook so they all use the SAME helper (no duplicated closures).
  const localizeError = makeLocalizeError(i18n);
  const traceLog = makeTraceLog(setVpnLogs);

  // ─── VPN status sync on mount ───
  useVpnStatusSnapshot({
    setStatus,
    setError,
    setConnectedSince,
    sawLiveStatusEventRef,
    localizeError,
  });

  // ─── VPN status event listener (single status owner, D-01) ───
  useVpnStatusListener({
    i18n,
    setStatus,
    setError,
    setConnectedSince,
    pushSuccess,
    setReconnectProgress,
    manualReconnectActiveRef,
    onSettled,
    switchSupersededRef,
    seamlessSwitchActiveRef,
    // F7 (Phase 17 review): the shared teardown-settled latch. The status listener reads it as the
    // `reconnectPending` guard to suppress the neutral disconnect snackbar on a manual
    // reconnect/switch teardown leg (restores the pre-CA-1 `!reconnectResolve.current` gate). It is
    // registered BEFORE useReconnectCompletionListener below (which nulls the ref on the same
    // event), so the read sees it still armed — identical ordering to the pre-extraction inline body.
    reconnectResolve,
    // BUG-A2 F1: the connect-cancel one-shot flag — reducer routes «Подключение отменено» + consumes it.
    connectCancelledRef,
    sawLiveStatusEventRef,
    localizeError,
    traceLog,
  });

  // ─── Internet-status display (reconnect is DRIVEN IN RUST; this only sets the banner) ───
  useInternetStatusListener({
    i18n,
    setError,
    traceLog,
  });

  // ─── Listen for disconnect confirmation to complete a manual reconnect ───
  useReconnectCompletionListener({
    reconnectResolve,
  });

  // ─── Conflicting VPN adapter warning (non-blocking) ───
  useAdapterConflictListener({
    setConflict,
    traceLog,
  });

  // ─── VPN log collector + error detection ───
  useVpnLogListener({
    i18n,
    setError,
    setVpnLogs,
  });
}
