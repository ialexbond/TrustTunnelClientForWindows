import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { VpnStatus, LogEntry, ReconnectProgress } from "../types";
import type { i18n as I18nType } from "i18next";

interface UseVpnEventsParams {
  i18n: I18nType;
  setStatus: React.Dispatch<React.SetStateAction<VpnStatus>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setConnectedSince: React.Dispatch<React.SetStateAction<Date | null>>;
  setVpnLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  reconnectResolve: React.MutableRefObject<(() => void) | null>;
  pushSuccess?: (msg: string, type?: "success" | "error") => void;
  // 02-20 status-UX split: per-attempt «Попытка N/N» progress lifted to App state so
  // StatusPanel can render the counter. Optional so existing call sites / tests that
  // don't surface the counter still type-check.
  setReconnectProgress?: React.Dispatch<React.SetStateAction<ReconnectProgress | null>>;
  // AUDIT-2026-06-11 #8: shared with useVpnActions (owned by App.tsx). True ONLY while
  // a manual «Сохранить и переподключить» (handleReconnect) is actually in flight.
  // The no-dwell guard below keys on it so a backend-driven `reconnecting →
  // disconnected` (tray disconnect during auto-reconnect) is no longer swallowed.
  // Optional so existing call sites / tests that don't wire it still type-check
  // (absent ref = guard never suppresses, which is the safe direction).
  manualReconnectActiveRef?: React.MutableRefObject<boolean>;
  // Phase 14 (14-04 / Pitfall 2): a DEFENSIVE backstop the App uses to clear its FE-only
  // `isSwitching` lock. Fired EXACTLY on the terminal `vpn-status` edge — `connected` OR `error`
  // (the two settle outcomes of a switch; a bare `disconnected` is the transient teardown, NOT a
  // settle). This is belt-to-the-finally's-suspenders: even if a switch promise is abandoned (a
  // dropped/never-resolving chain), the terminal edge still releases the lock so the UI can never
  // wedge locked. It MUST land on the terminal-edge branch below — NOT inside/broadening the
  // no-dwell guard (broadening risks eating a REAL terminal disconnect — AUDIT #8 stuck-on-yellow).
  // Optional so call sites / tests that don't wire it keep type-checking (they simply get no clear).
  //
  // Phase 14 (FAB-02): the terminal STATUS (`connected` | `error`) is passed so the App can settle
  // its switch on the REAL terminal edge — `switchTo` resolves at spawn-accept, but a spawned B can
  // still die never-connected. performSwitch awaits this edge: `connected` → success (stamp
  // last-used), `error` → silent revert. The App resolves an internal settle-promise from here.
  onSettled?: (terminalStatus: "connected" | "error") => void;
  // F-7 (Fable-5): set by App when a switch is SUPERSEDED by a genuine user disconnect (a tray
  // «Отключить» mid-switch, or vpn_connect bailing spawned:false). Rust then writes a
  // connecting → disconnected edge which the snackbar below would otherwise map to the RED
  // «Connection failed» — but this was a user-intended disconnect, not a connect failure. The
  // connecting→disconnected arm consults + CONSUMES this ref to show the neutral «VPN отключён»
  // instead. Optional so call sites / tests that don't wire it keep type-checking.
  switchSupersededRef?: React.MutableRefObject<boolean>;
  // F17 (14-UAT round 2): set by App (mirrors isSwitching) across the WHOLE seamless switch+revert
  // window. While true, the disconnected-edge snackbars — the red «Connection failed» (connecting→
  // disconnected) AND the neutral «VPN отключён» (connected/disconnecting→disconnected) — are
  // SUPPRESSED: a seamless switch/revert stays calm (amber card + embedded «…восстановлено» banner),
  // it must not flash a disconnect snackbar for a failed B or the revert leg. Distinct from
  // switchSupersededRef (a one-shot tray-supersede flag); this spans the whole switch. Optional so
  // call sites / tests that don't wire it keep type-checking.
  seamlessSwitchActiveRef?: React.MutableRefObject<boolean>;
  // T-34 (Phase 16): lift the log-only `vpn-adapter-conflict` payload into React state so the UI can
  // render the second-VPN warning banner (ErrorBanner variant="warning"). The listener below keeps
  // its existing traceLog line AND calls this when supplied — a second VPN client (its adapter name
  // already own-filtered by T-21 Rust-side) can contend for routes/adapter and destabilize the
  // tunnel, so we warn the user without blocking. Optional so existing call sites / tests that don't
  // surface the banner still type-check (absent = today's log-only behavior, unchanged).
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
  setConflict,
}: UseVpnEventsParams) {
  // AUDIT-2026-06-11 #14: the mount snapshot (check_vpn_status_full) and the live
  // vpn-status listener are independent async channels — the IPC reply can land
  // AFTER a newer live event (webview remount mid-auto-reconnect: snapshot reads
  // "reconnecting", supervisor then emits "connected", then the stale snapshot
  // reply would roll status back to "reconnecting" with nothing left to correct
  // it). The listener flips this ref first thing; the snapshot applies its result
  // only while the ref is still false (a live event is always newer than the
  // snapshot taken at mount). The ref never SYNTHESIZES status — it only gates
  // the frontend's own snapshot write (D-01: the vpn-status event stays the owner).
  const sawLiveStatusEventRef = useRef(false);
  // ─── Helper: map a stable backend reason CODE to a localized display string ───
  //
  // The backend (vpn.rs connect-timeout watchdog, Plan 02-02) sets the Error with a
  // STABLE ASCII reason code — never a user-facing string (CLAUDE.md i18n rule +
  // D-29). We localize it HERE so the slice ships honestly: the user sees the
  // Russian (primary) / English (mirror) message, never the raw `connect-timeout`
  // code (Codex SAFETY-03 seam). Any error that is NOT a known reason code passes
  // through unchanged (older sanitized backend messages still render verbatim).
  //
  // Structured as a lookup so 02-04 can add `reconnect-gave-up` with a single line.
  // 02-04: the Rust reconnect supervisor (connectivity.rs) sets a terminal
  // `VpnStatus::Error` carrying the STABLE `reconnect-gave-up` code after 3 failed
  // attempts — localized here to `errors.reconnect_gave_up` so the user sees the
  // Russian (primary) message, never the raw code (CLAUDE.md i18n rule).
  // 02-09 (UAT Gap #2): the sidecar Terminated arm now emits two STABLE reason codes
  // for a never-connected non-zero exit — `no-internet` (the pre-flight saw the network
  // as down) and `sidecar-exit` (generic VPN-core failure / AV-kill mid-connect). They
  // localize through this same map so the user sees the friendly Russian (primary) /
  // English (mirror) message, never the raw code (and never the old raw
  // "Process exited with code N" passthrough that this plan removed).
  // 02-20: `recovery-timeout` is the new terminal code the Rust adapter-wait emits
  // when the local network never returns within RECOVERY_TIMEOUT (internet-lost path).
  // Localized here like every other stable code so the user sees the friendly Russian
  // (primary) / English (mirror) message, never the raw `recovery-timeout` ASCII.
  const REASON_CODE_I18N: Record<string, string> = {
    "connect-timeout": "errors.connect_timeout",
    "reconnect-gave-up": "errors.reconnect_gave_up",
    "recovery-timeout": "errors.recovery_timeout",
    "no-internet": "errors.no_internet",
    "sidecar-exit": "errors.sidecar_exit",
    // AUDIT-2026-06-11 #20: emitted by vpn_disconnect when BOTH kill paths fail —
    // the sidecar may still be alive holding the killswitch, so the message must
    // tell the user honestly instead of leaking the raw token.
    "disconnect-failed": "errors.disconnect_failed",
  };
  // F16 (14-UAT round 2): the C++ sidecar emits a handful of FIXED English phrases on the
  // vpn-status error payload (fatal_marker_error / config_parse_error in
  // src-tauri/src/sidecar.rs:121-127,161). They are stable DERIVED phrases (D-29-safe, never
  // raw log text) but are NOT ASCII reason codes, so localizeError used to pass them straight
  // through — leaking English «Server refused the connection»/«Authorization failed» into the
  // Russian UI (both the snackbar and the StatusPanel banner). Map each to its existing
  // localized key. Keep this byte-for-byte in sync with sidecar.rs; if a phrase drifts it
  // silently degrades to passthrough (today's behavior), never a crash.
  const CORE_MESSAGE_I18N: Record<string, string> = {
    "Authorization failed": "errors.auth_required",
    "VPN adapter creation failed": "errors.wintun_missing",
    "Failed to start VPN tunnel": "errors.listener_failed",
    "Server refused the connection": "errors.connection_refused",
    "Configuration parse error. Check your config file.": "errors.config_parse_error",
  };
  const localizeError = (error: string | null | undefined): string | null => {
    if (!error) return error ?? null;
    const key = REASON_CODE_I18N[error] ?? CORE_MESSAGE_I18N[error];
    return key ? i18n.t(key) : error;
  };
  // ─── Helper: write trace log visible in Log Panel ───
  const traceLog = (msg: string) => {
    const now = new Date();
    const ts = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
    setVpnLogs(prev => {
      const next = [...prev, { timestamp: ts, level: "info", message: `[connectivity] ${msg}` }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  };
  // ─── VPN status sync on mount ───
  useEffect(() => {
    // Codex MEDIUM: a window that mounts AFTER an `error` event must recover BOTH
    // the status AND its reason. The old check_vpn_status snapshot returned only a
    // status string, so a late-mounting window rendered "error" with no detail.
    // check_vpn_status_full returns the same { status, error } shape as the
    // "vpn-status" event (the backend persists last_error alongside vpn_status), so
    // we restore the reason here too. `error` is the already-sanitized backend
    // string (D-29) — never a raw secret.
    invoke<{ status: VpnStatus; error: string | null }>("check_vpn_status_full")
      .then(({ status, error }) => {
        // AUDIT-2026-06-11 #14: a live vpn-status event already arrived while this
        // IPC reply was in flight — the event is strictly newer than the snapshot,
        // so applying the snapshot now would roll the status BACK (e.g. connected →
        // reconnecting, permanently, since a settled backend emits nothing further).
        // Drop the stale snapshot entirely (status AND its error payload).
        if (sawLiveStatusEventRef.current) return;
        if (status === "connected") {
          setStatus("connected");
          setConnectedSince((prev) => prev ?? new Date());
        } else if (status === "connecting") {
          setStatus("connecting");
          setConnectedSince(null);
        } else if (status === "error") {
          setStatus("error");
          setConnectedSince(null);
        } else if (status === "recovering" || status === "reconnecting") {
          // Plan 02-08 (T-08-02): a window mounting mid-reconnect must render the
          // recovering/reconnecting label from the snapshot, not fall through to
          // "disconnected". The backend snapshot (check_vpn_status_full) returns the
          // canonical wire string while the Rust supervisor retries, matching the live
          // "vpn-status" event — so the late-mount path and the live path agree.
          // 02-20: «Восстановление» (recovering, local-net wait) and «Переподключение»
          // (reconnecting, re-establish) are now distinct snapshot states; both mean
          // the session is NOT up, so connectedSince is cleared for either.
          setStatus(status);
          setConnectedSince(null);
        } else if (status === "disconnecting") {
          // F-9 (Fable-5): a window mounting mid-teardown (the 3.4 Disconnecting transient can be
          // in flight up to ~7s under 3.2) must render «Отключение», not collapse to «Отключено».
          // The backend snapshot returns the canonical wire string, matching the live event.
          setStatus("disconnecting");
          setConnectedSince(null);
        } else {
          setStatus("disconnected");
          setConnectedSince(null);
        }
        // Restore the reason whenever the snapshot carries one (an error that fired
        // before this window finished mounting). Localize a known reason code so a
        // late-mounting window also shows the friendly message, not the raw code.
        if (error) {
          setError(localizeError(error));
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setStatus, setError, setConnectedSince]);

  // ─── VPN status event listener ───
  useEffect(() => {
    // D-08 / Pitfall 3: harden the async-unlisten StrictMode race. listen()
    // returns a Promise<UnlistenFn>; under React 19 StrictMode the effect can
    // be torn down before that promise resolves. A bare
    // `unlisten.then((f) => f())` cleanup can let a late-resolving listener
    // survive the unmount (double registration → double status updates /
    // blink). We guard with a `cancelled` flag + stored fn: if cleanup already
    // ran by the time listen() resolves, unlisten immediately.
    let cancelled = false;
    let resolvedUnlisten: (() => void) | null = null;
    const unlistenStatus = listen<{ status: VpnStatus; error?: string; attempt?: number; max?: number }>(
      "vpn-status",
      (event) => {
        // AUDIT-2026-06-11 #14: mark BEFORE any processing — from this moment the
        // mount snapshot is stale and must not apply (see the snapshot effect above).
        sawLiveStatusEventRef.current = true;
        traceLog(`vpn-status: ${event.payload.status}${event.payload.error ? ` error=${event.payload.error}` : ""}`);

        // 02-20: surface the per-attempt «Попытка N/N» counter. The backend attaches
        // `attempt`/`max` ONLY on a `reconnecting` event from the server-silent retry
        // supervisor. Store them when present so StatusPanel can render the progress;
        // clear them on ANY other status so a stale «Попытка 3/3» can't linger over a
        // later «Подключено» / «Восстановление» / «Отключено». Done outside the
        // setStatus updater (no dependency on prev) — a plain idempotent side effect.
        if (event.payload.status === "reconnecting" && typeof event.payload.attempt === "number" && typeof event.payload.max === "number") {
          setReconnectProgress?.({ attempt: event.payload.attempt, max: event.payload.max });
        } else if (
          event.payload.status === "connected" ||
          event.payload.status === "disconnected" ||
          event.payload.status === "error"
        ) {
          // F0/F4: clear «Попытка N/N» only on a TERMINAL status. The old code cleared it
          // on ANY non-reconnecting event, so a transient interleave (e.g. a recovering
          // tick between two reconnecting attempts) wiped the counter before it could
          // render — one reason the user never saw «Попытка N/N». Keeping it across
          // recovering/connecting lets the counter survive to the screen.
          setReconnectProgress?.(null);
        }

        setStatus((prev) => {
          // F0 (no-dwell guard, NARROWED — Codex M1): suppress an intermediate
          // "disconnected" ONLY during «Переподключение» (a manual save+reconnect, where
          // useVpnActions sets prev = "reconnecting" up-front and the teardown emits a
          // transient "disconnected" we hide so the label stays continuous — no «Отключено»
          // flash). We DO NOT suppress it for prev === "recovering": from «Восстановление»
          // a "disconnected" is ALWAYS terminal — the network returned but there is no
          // saved config to reconnect to (WR-03), or a give-up cleanup resolved to
          // Disconnected. The old guard suppressed BOTH, so that legitimate terminal
          // Disconnected was hidden and the UI stuck on red «Восстановление» indefinitely.
          //
          // AUDIT-2026-06-11 #8 (NARROWED AGAIN): keying on prev alone also ate a REAL
          // terminal Disconnected — during a backend AUTO-reconnect (supervisor sets
          // status "reconnecting") a tray disconnect emits a single "disconnected"
          // (tray_vpn_disconnect / the supervisor's T-31 forced Disconnected send no
          // intermediate status), and the unconditional guard suppressed it forever:
          // the window stuck on yellow «Переподключение» while the tray went grey.
          // Suppress only while a MANUAL frontend reconnect is actually in flight —
          // useVpnActions.handleReconnect flips the shared ref true synchronously
          // before its optimistic setStatus("reconnecting") and clears it before
          // reconnecting (plus a 5s safety timeout), so the teardown's transient
          // "disconnected" is hidden exactly for that window and nothing else.
          // B5 (16-UAT round 2): «Сохранить и переподключить» must stay seamless — a continuous
          // amber «Переподключение», never a «Отключение»/«Отключён» flash. The backend now emits
          // `Disconnecting` FIRST at every real teardown (vpn.rs 3.4 R-DCT), so the guard must hold
          // on BOTH the leading `disconnecting` transient AND the settled `disconnected`. Before this,
          // the guard matched only `disconnected`: the `disconnecting` leaked → «Отключение», then
          // `disconnected` arrived with prev==="disconnecting" (guard missed it) → «Отключён».
          // Still keyed on prev==="reconnecting" && manualReconnectActiveRef — NOT broadened to
          // recovering/no-mark, so a REAL terminal disconnect during an AUTO-reconnect still commits
          // (AUDIT #8 stuck-on-yellow fix intact: that path has manualReconnectActiveRef.current false).
          if (
            prev === "reconnecting" &&
            (event.payload.status === "disconnected" || event.payload.status === "disconnecting") &&
            manualReconnectActiveRef?.current
          ) {
            return prev;
          }

          // Show appropriate snackbar based on transition
          if (event.payload.status === "connected") {
            setConnectedSince(new Date());
            // WR-01: clear any prior recovery/error message on a successful
            // (re)connect. The internet-status listener sets setError(...) when
            // connectivity drops, but a Rust-driven auto-reconnect recovers the
            // session via this vpn-status "connected" event WITHOUT going through
            // handleConnect (the only other path that cleared the error). Without
            // this, the red "Интернет-соединение потеряно…" banner lingers over
            // the green Connected badge after recovery.
            setError(null);
            pushSuccess?.(i18n.t("messages.vpn_connected", "VPN connected"));
          } else if (event.payload.status === "disconnected") {
            setConnectedSince(null);
            // F17 (14-UAT round 2): during a seamless switch+revert the app stays calm — the amber
            // card + the embedded «…восстановлено» info banner are the ONLY failure signals. Suppress
            // BOTH disconnect snackbars (the red «Connection failed» for a failed B, and the neutral
            // «VPN отключён» for the revert/teardown leg) while isSwitching is mirrored here. Control
            // flow — incl. the one-shot switchSupersededRef consume — is UNCHANGED; only the snackbar
            // emission is gated, so a genuine (non-switch) disconnect still shows its snackbar.
            const suppressDisconnectSnack = seamlessSwitchActiveRef?.current ?? false;
            if (prev === "connecting") {
              if (switchSupersededRef?.current) {
                // F-7 (Fable-5): a genuine user disconnect SUPERSEDED an in-flight switch (tray
                // «Отключить» mid-switch, or vpn_connect bailing spawned:false). The
                // connecting→disconnected edge here is the user's intended disconnect, NOT a connect
                // failure — show the neutral «VPN отключён», never the red «Connection failed».
                // Consume the flag so a later real connect failure still shows red.
                switchSupersededRef.current = false;
                if (!suppressDisconnectSnack)
                  pushSuccess?.(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
              } else if (!suppressDisconnectSnack) {
                // Was trying to connect → connection failed. F16: localize the core's error
                // phrase (e.g. «Server refused the connection») via localizeError instead of
                // leaking it raw; when the payload has no error, fall back to the localized
                // generic errors.connection_failed (ru source + en mirror), NOT an English default.
                pushSuccess?.(
                  localizeError(event.payload.error) || i18n.t("errors.connection_failed"),
                  "error"
                );
              }
            } else if (
              (prev === "connected" || prev === "disconnecting") &&
              !reconnectResolve.current &&
              !suppressDisconnectSnack
            ) {
              // Was connected (or in the new 3.4 Disconnecting teardown) → normal disconnect, not part
              // of a reconnect. With the real Disconnecting wire status a genuine user disconnect now
              // arrives as Connected → Disconnecting → Disconnected, so the settled edge's `prev` is
              // "disconnecting" — recognise it too, else the «VPN отключён» snackbar would be lost.
              pushSuccess?.(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
            }
          } else if (event.payload.status === "error") {
            // B1 (16-UAT round 2): an in-app snackbar must ALSO fire on a connect FAILURE, not only
            // the desktop plate (notify.rs maps Error → ConnectionError on the →error edge). An
            // auth/connect failure arrives here as status:"error" (sidecar «Authorization Required» →
            // fatal_marker_error → set_vpn_status(Error)); previously this only set the persistent
            // banner (setError, below) — no snackbar, so the two surfaces disagreed. We now ALSO toast,
            // guarded exactly like the disconnect snackbar:
            //   • fire ONLY from an in-flight connect that failed (prev connecting/reconnecting) — so a
            //     late-mount snapshot landing on error, or a re-emit of an already-error status, does
            //     NOT re-toast;
            //   • SUPPRESS during a seamless switch/revert (a failed B already surfaces via the calm
            //     amber card + «…восстановлено» info banner — it must not also red-toast).
            // The persistent banner (setError, at the bottom of this listener) is UNCHANGED — the owner
            // wants BOTH the snackbar and the plate/banner.
            const suppressErrorSnack = seamlessSwitchActiveRef?.current ?? false;
            if ((prev === "connecting" || prev === "reconnecting") && !suppressErrorSnack) {
              pushSuccess?.(
                localizeError(event.payload.error) || i18n.t("errors.connection_failed"),
                "error",
              );
            }
          } else if (
            event.payload.status === "recovering" ||
            event.payload.status === "reconnecting" ||
            // 3.4 R-DCT: stop the uptime clock the moment the teardown starts (the real Disconnecting
            // wire status), not only once it settles Disconnected.
            event.payload.status === "disconnecting"
          ) {
            // F1: a drop is NOT "up" — stop the uptime clock. Without this the timer kept
            // ticking under the «Восстановление»/«Переподключение» label (a visible
            // symptom of the stuck-green bug — the badge said «Подключено» and the timer
            // counted up while the network was gone). Mirrors the mount-snapshot path.
            setConnectedSince(null);
          }

          return event.payload.status;
        });
        // Phase 14 (14-04 / Pitfall 2): DEFENSIVE isSwitching clear on the TERMINAL edge. A switch
        // settles on exactly two outcomes — `connected` (B is up) or `error` (B failed → the App
        // reverts to A). Fire onSettled here so the App's isSwitching lock is released even if a
        // switch promise was abandoned (a dropped/never-resolving chain that never hit its finally).
        // This is placed on the terminal-edge branch OUTSIDE the no-dwell guard on purpose — it must
        // NOT be inside/broaden that guard (broadening risks swallowing a real terminal disconnect —
        // AUDIT #8 stuck-on-yellow). A bare `disconnected` is the switch's TRANSIENT teardown, not a
        // settle, so it deliberately does NOT fire onSettled (visual continuity comes from isSwitching
        // keeping the hero live, not from this callback).
        if (event.payload.status === "connected" || event.payload.status === "error") {
          onSettled?.(event.payload.status);
        }
        if (event.payload.error) {
          // Localize a stable reason code (e.g. `connect-timeout`) to a friendly
          // message; non-code errors pass through unchanged (SAFETY-03).
          setError(localizeError(event.payload.error));
        } else if (event.payload.status === "disconnected" || event.payload.status === "connecting") {
          // F3: a clean/terminal "disconnected" OR a fresh «Подключение» carries no error —
          // clear any stale banner so the badge and the banner never disagree. The
          // "connecting" case fixes the TRAY-menu connect (UAT fd63ec): the tray
          // «Подключиться» goes through the backend, which doesn't clear the FE error the way
          // the main window's handleConnect does (setError(null)), so the old error banner
          // lingered under the yellow «Подключение». recovering/reconnecting are intentionally
          // NOT cleared here — they carry their own internet-status banner. "connected"
          // already clears it above (WR-01).
          setError(null);
        }
      },
    );
    unlistenStatus.then((f) => {
      if (cancelled) {
        // Effect was already torn down — unlisten the just-resolved listener
        // immediately so it can't survive into the next mount.
        f();
      } else {
        resolvedUnlisten = f;
      }
    });
    return () => {
      cancelled = true;
      if (resolvedUnlisten) resolvedUnlisten();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setStatus, setError, setConnectedSince]);

  // ─── Internet-status display (reconnect is now DRIVEN IN RUST) ───
  //
  // STATUS-05 / D-01 / Pitfall 2 (Plan 02-04): the window-independent Rust reconnect
  // supervisor (connectivity.rs `start_reconnect_supervisor`) is now the SOLE owner
  // of auto-reconnect — triggered by BOTH a sidecar process exit (sidecar.rs
  // Terminated arm) AND a live-sidecar connectivity loss (connectivity.rs monitor).
  // The old `action === "reconnect"` branch here used to drive reconnect from a
  // MOUNTED React effect that invoked the connect command with a localStorage path,
  // so recovery only fired while this window was open. It is DELETED in the same
  // plan the Rust supervisor lands so there is never a double-reconnect window
  // (Open Q2).
  //
  // This effect now only enriches the user-facing MESSAGE (setError). It must NEVER
  // set the status and must NEVER invoke the connect command — Rust owns BOTH.
  //
  // 02-20 STATUS CONFLICT FIX: the old `disconnect` branch did `setStatus("recovering")`.
  // That conflicted with the new split — the backend now distinguishes a `tunnel-lost`
  // drop (server dead, net up → authoritative `reconnecting`) from an `internet-lost`
  // drop (local net gone → authoritative `recovering`), and emits the correct status on
  // the `vpn-status` event. If this handler ALSO forced `recovering`, a `tunnel-lost`
  // drop the backend set to `reconnecting` would be clobbered back to `recovering` (red,
  // wrong label). So the `vpn-status` listener is now the SOLE status owner (D-01); this
  // handler only sets the descriptive banner message. `internet-status` `disconnect`
  // fires only on a real local-net loss, so its message is the internet-lost one.
  useEffect(() => {
    const unlistenInternet = listen<{ online: boolean; action?: string; reason?: string }>(
      "internet-status",
      async (event) => {
        const { online, action, reason } = event.payload;
        traceLog(`event: online=${online}, action=${action ?? "none"}${reason ? `, reason=${reason}` : ""}`);

        if (!online && action === "disconnect") {
          // WR-01: the backend fires this SAME `disconnect` event for BOTH drop types
          // and tags them via `reason` (declare_offline_and_handoff sets
          // `tunnel-lost` for a server-silent drop, `internet-lost` for a local-net
          // loss). The old code ignored `reason` and always showed the internet-lost
          // banner, so a server-lost («Переподключение») retry displayed the wrong
          // «Интернет-соединение потеряно…» message (SPEC §2/§3 wants «Связь с
          // сервером потеряна»). Branch on the reason so the banner matches the
          // authoritative status the vpn-status event sets (D-01 still owns status).
          // The banner is the SINGLE source of this sentence — StatusPanel's
          // reconnecting sub-text now renders ONLY the «Попытка N/N» counter so the two
          // never duplicate the same line.
          traceLog("Connectivity lost — Rust supervisor is recovering the connection...");
          setError(
            reason === "tunnel-lost"
              ? i18n.t("errors.server_connection_lost")
              : i18n.t("errors.internet_lost_disconnecting"),
          );
        } else if (!online && action === "give_up") {
          // Backend gave up waiting for the adapter. We surface the friendly message;
          // the terminal STATUS (error) arrives via the vpn-status event carrying the
          // `recovery-timeout` reason code — we do NOT force a status here.
          traceLog("Gave up waiting for network recovery");
          setError(i18n.t("errors.network_recovery_timeout"));
        }
        // The `reconnect` action is intentionally NOT handled here anymore — Rust
        // owns reconnect (Pitfall 2 / Open Q2). The backend's terminal outcome
        // (recovered / reconnect-gave-up / recovery-timeout Error) arrives via the
        // vpn-status listener, which is the single status owner (D-01).
      },
    );
    return () => { unlistenInternet.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n, setError]);

  // ─── Listen for disconnect confirmation to complete reconnect ───
  useEffect(() => {
    // Same async-unlisten hardening as the primary vpn-status listener (D-08).
    let cancelled = false;
    let resolvedUnlisten: (() => void) | null = null;
    const unlisten = listen<{ status: VpnStatus }>("vpn-status", (event) => {
      if (event.payload.status === "disconnected" && reconnectResolve.current) {
        const resolve = reconnectResolve.current;
        reconnectResolve.current = null;
        resolve();
      }
    });
    unlisten.then((f) => {
      if (cancelled) f();
      else resolvedUnlisten = f;
    });
    return () => {
      cancelled = true;
      if (resolvedUnlisten) resolvedUnlisten();
    };
  }, [reconnectResolve]);

  // ─── Conflicting VPN adapter warning (non-blocking) ───
  // T-34 (Phase 16): this listener used to be LOG-ONLY. It still writes the same trace line to the
  // Log Panel, but now ALSO lifts the payload into React state (setConflict, when wired) so the
  // «Подключение» tab can render the yellow second-VPN ErrorBanner. The payload's `adapters` are
  // already own-adapter-filtered Rust-side (T-21), so anything here is a genuinely foreign VPN.
  useEffect(() => {
    const unlisten = listen<{ adapters: string[]; message: string }>(
      "vpn-adapter-conflict",
      (event) => {
        const { adapters, message } = event.payload;
        traceLog(`WARNING: Conflicting adapters detected: ${adapters.join(", ")}. If connection fails, disable them.`);
        setConflict?.({ adapters, message });
      },
    );
    return () => { unlisten.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── VPN log collector + error detection ───
  useEffect(() => {
    const unlisten = listen<{ message: string; level?: string }>("vpn-log", (event) => {
      const msg = event.payload.message.trim();
      if (!msg) return;
      const now = new Date();
      const ts = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
      // WR-04: the backend emits `{ message, level }` (level computed by
      // parse_log_level in sidecar.rs) — there is NO `source` field. The old
      // `event.payload.source === "stderr"` was always undefined, so every line
      // (including real [error] lines) was rendered at "info". Read the field the
      // backend actually sends so error log lines colour correctly.
      const level = event.payload.level ?? "info";
      setVpnLogs(prev => {
        const next = [...prev, { timestamp: ts, level, message: msg }];
        return next.length > 500 ? next.slice(-500) : next;
      });

      // ── DEV-only F12 console mirror (D-08 / D-11) ──
      //
      // D-08: stream every `vpn-log` line to the browser DevTools (F12) console
      // so the user can watch the connection live and paste the logs straight
      // back — neither user nor support has to guess when something breaks.
      //
      // D-11 (user decision 2026-06-04): the F12 mirror + the verbose lifecycle
      // logging are a DEV-BUILD-ONLY aid. We gate the mirror behind
      // `import.meta.env.DEV` so a production/release build NEVER streams the
      // verbose `vpn-log` channel to `console`. Tauri also disables DevTools in
      // release, but this gate makes the mirror code path provably dead in a
      // shipped build — so the full-channel mirror cannot leak a pre-existing
      // raw line in production (closes the cross-AI review's D-29 concern WITHOUT
      // a heavyweight whole-channel re-sanitization; the channel was already
      // hardened in Phase 1 / CR-01, and the new markers are fixed sanitized
      // phrases). The trace-log append above + setError below run in ALL builds;
      // ONLY this console mirror is dev-gated.
      if (import.meta.env.DEV) {
        const mirror =
          level === "error" ? console.error
          : level === "warn" ? console.warn
          // eslint-disable-next-line no-console -- DEV-only F12 mirror (D-08/D-11); gated off in release
          : console.log;
        mirror(`[vpn] ${msg}`);
      }

      // ── Detect known errors and show user-friendly messages ──
      //
      // STATUS-03 / D-07: status is NO LONGER inferred from log text here.
      // The backend (sidecar.rs, plan 01-01) now emits an authoritative
      // VpnStatus::Error event for these same 4 fatal markers, so the error
      // STATUS arrives via the "vpn-status" listener above — the single source
      // of truth (Rust → event → frontend). This listener only enriches the
      // user-facing MESSAGE (setError) and appends the raw line to the log
      // buffer; it must never call setStatus (that would re-introduce a
      // parallel status owner). See .planning/phases/01-.../01-PATTERNS.md.
      if (msg.includes("Authorization Required")) {
        setError(i18n.t("errors.auth_required", "Ошибка авторизации: логин или пароль неверны. Обновите конфиг с сервера через Панель управления."));
      } else if (msg.includes("WintunCreateAdapter") && msg.includes("cannot find")) {
        setError(i18n.t("errors.wintun_missing", "Не удалось создать VPN-адаптер. Запустите приложение от имени администратора."));
      } else if (msg.includes("Failed to create listener")) {
        setError(i18n.t("errors.listener_failed", "Не удалось запустить VPN-туннель. Проверьте права администратора и наличие wintun.dll."));
      } else if (msg.includes("Connection refused") || msg.includes("connection refused")) {
        setError(i18n.t("errors.connection_refused", "Сервер отклонил подключение. Проверьте, запущен ли VPN-сервис на сервере."));
      } else if (msg.includes("timed out") || msg.includes("Timed out")) {
        // Show a hint for the fatal adapter-setup timeout, but (like the
        // markers above) do NOT set status — the backend owns that now.
        if (msg.includes("Failed to setup adapter")) {
          setError(i18n.t("errors.adapter_timeout", "Таймаут создания VPN-адаптера. Перезапустите приложение от имени администратора."));
        }
      }
    });
    return () => { unlisten.then((f) => f()); };
    // setStatus intentionally absent: the vpn-log listener no longer sets
    // status (STATUS-03 / D-07) — it only sets the error message + log buffer.
  }, [i18n, setError, setVpnLogs]);
}
