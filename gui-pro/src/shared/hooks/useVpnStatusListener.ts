import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { VpnStatus, ReconnectProgress } from "../types";
import type { i18n as I18nType } from "i18next";
import { reduceVpnStatus } from "./useVpnStatusReducer";

// Phase 17 (17-05, CA-1) — the `vpn-status` live listener, split out of the useVpnEvents
// god-hook. It is the SINGLE frontend owner of VPN status (D-01): status comes ONLY from this
// event (+ the mount snapshot), never inferred from log text. It applies the pure
// reduceVpnStatus reducer inside the setStatus updater and replays the declarative effects
// (behavior byte-identical to the pre-split inline listener — 17-RESEARCH Pitfall 4).

interface UseVpnStatusListenerParams {
  i18n: I18nType;
  setStatus: React.Dispatch<React.SetStateAction<VpnStatus>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setConnectedSince: React.Dispatch<React.SetStateAction<Date | null>>;
  pushSuccess?: (msg: string, type?: "success" | "error") => void;
  setReconnectProgress?: React.Dispatch<React.SetStateAction<ReconnectProgress | null>>;
  manualReconnectActiveRef?: React.MutableRefObject<boolean>;
  onSettled?: (terminalStatus: "connected" | "error") => void;
  switchSupersededRef?: React.MutableRefObject<boolean>;
  seamlessSwitchActiveRef?: React.MutableRefObject<boolean>;
  // F7 (Phase 17 review): the shared teardown-settled latch. Armed (`!== null`) while a manual
  // «Сохранить и переподключить» / a manual switch is waiting for its teardown `disconnected`.
  // The reducer reads it as the `reconnectPending` guard to suppress the neutral «VPN отключён»
  // snackbar on the teardown leg (restores the pre-CA-1 inline `!reconnectResolve.current` gate).
  // This listener is registered BEFORE the reconnect-completion listener (which nulls the ref),
  // so the read here sees it still armed — the same ordering as the pre-extraction inline body.
  reconnectResolve?: React.MutableRefObject<(() => void) | null>;
  // BUG-A2 (17-uat, Fable F1): set by App's handleUserCancel when the user cancels an IN-FLIGHT
  // connect/recovery. The reducer reads it as the `connectCancelled` guard to route the distinct
  // «Подключение отменено» toast on the terminal `disconnected` edge (NOT prev-based — prev is
  // `disconnecting` there), and CONSUMES it via `consume-connect-cancelled` (this listener clears the
  // ref) on any terminal edge. Optional so test call sites that don't wire it keep type-checking.
  connectCancelledRef?: React.MutableRefObject<boolean>;
  // AUDIT-2026-06-11 #14: the shared «a live event has arrived» ref. The listener flips it true
  // first thing so the mount snapshot (a strictly-older async channel) knows it is stale. Owned
  // by useVpnEvents (shared with the snapshot hook); the listener never SYNTHESIZES status from
  // it — it only marks that a live event happened.
  sawLiveStatusEventRef: React.MutableRefObject<boolean>;
  // Shared helpers (localizeError needs i18n, traceLog needs setVpnLogs) — built once in
  // useVpnEvents and passed down so every per-signal hook uses the SAME helper.
  localizeError: (error: string | null | undefined) => string | null;
  traceLog: (msg: string) => void;
}

export function useVpnStatusListener({
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
  reconnectResolve,
  connectCancelledRef,
  sawLiveStatusEventRef,
  localizeError,
  traceLog,
}: UseVpnStatusListenerParams) {
  useEffect(() => {
    // D-08 / Pitfall 3: harden the async-unlisten StrictMode race. listen() returns a
    // Promise<UnlistenFn>; under React 19 StrictMode the effect can be torn down before that
    // promise resolves. A bare `unlisten.then((f) => f())` cleanup can let a late-resolving
    // listener survive the unmount (double registration → double status updates / blink). We
    // guard with a `cancelled` flag + stored fn: if cleanup already ran by the time listen()
    // resolves, unlisten immediately.
    let cancelled = false;
    let resolvedUnlisten: (() => void) | null = null;
    const unlistenStatus = listen<{ status: VpnStatus; error?: string; attempt?: number; max?: number; failover?: boolean; server?: string }>(
      "vpn-status",
      (event) => {
        // AUDIT-2026-06-11 #14: mark BEFORE any processing — from this moment the mount snapshot
        // is stale and must not apply (see useVpnStatusSnapshot).
        sawLiveStatusEventRef.current = true;
        traceLog(`vpn-status: ${event.payload.status}${event.payload.error ? ` error=${event.payload.error}` : ""}`);

        // 02-20: surface the reconnect progress counter. The backend attaches `attempt`/`max`
        // ONLY on a `reconnecting` event from the server-silent retry supervisor. Store them when
        // present so StatusPanel can render the progress; clear them on a TERMINAL status so a
        // stale counter can't linger over a later «Подключено» / «Восстановление» / «Отключено».
        // Done outside the setStatus updater (no dependency on prev) — a plain idempotent side
        // effect. F0/F4: cleared only on connected/disconnected/error (a transient recovering
        // interleave must not wipe the counter before it renders).
        //
        // `failover` rides along and says what the two numbers MEAN — retries of one server, or a
        // position in the queue of servers. It is carried, never interpreted here; the sentence is
        // StatusPanel's job.
        if (event.payload.status === "reconnecting" && typeof event.payload.attempt === "number" && typeof event.payload.max === "number") {
          setReconnectProgress?.({
            attempt: event.payload.attempt,
            max: event.payload.max,
            failover: event.payload.failover === true,
            server: event.payload.server ?? null,
          });
        } else if (
          event.payload.status === "connected" ||
          event.payload.status === "disconnected" ||
          event.payload.status === "error"
        ) {
          setReconnectProgress?.(null);
        }

        setStatus((prev) => {
          // 17-05 (CA-1): the transition matrix is the PURE reduceVpnStatus reducer —
          // exhaustively unit-tested so its 8+ historical guards (F0/F4/F16/F17/AUDIT-8/B1/B5/F-7)
          // are provably behavior-preserving. This updater just REPLAYS the declarative effects it
          // emits, in emission order (Pitfall 4: effect ORDER + guard conditions unchanged). The
          // reducer stays side-effect-free; the actual React setters + the localized snackbar TEXT
          // live here (localizeError needs i18n).
          const { nextStatus, effects } = reduceVpnStatus(
            prev,
            { status: event.payload.status, error: event.payload.error },
            {
              manualReconnectActive: manualReconnectActiveRef?.current ?? false,
              seamlessSwitchActive: seamlessSwitchActiveRef?.current ?? false,
              switchSuperseded: switchSupersededRef?.current ?? false,
              // F7: the teardown-settled latch is armed → this `disconnected` is a manual
              // reconnect/switch teardown leg (owned by the completion listener), not a
              // user-visible disconnect → suppress the neutral snackbar (pre-CA-1 parity).
              reconnectPending: reconnectResolve?.current != null,
              // BUG-A2 F1: the user cancelled an in-flight connect/recovery → route «Подключение
              // отменено» on the terminal disconnected edge (prev is `disconnecting` there, so this
              // MUST be flag-based, not prev-based). Consumed via consume-connect-cancelled below.
              connectCancelled: connectCancelledRef?.current ?? false,
            },
          );

          for (const effect of effects) {
            switch (effect) {
              case "set-connected-since":
                setConnectedSince(new Date());
                break;
              case "clear-uptime":
                // F1 / 3.4 R-DCT: a drop/teardown is NOT "up" — stop the uptime clock (also the
                // disconnected-from-connected edge).
                setConnectedSince(null);
                break;
              case "clear-error":
                // WR-01: clear any lingering recovery/error banner on the → connected edge so the
                // red «Интернет-соединение потеряно…» banner cannot linger over the green badge after
                // a Rust-driven auto-reconnect (which never goes through handleConnect).
                setError(null);
                break;
              case "snack:connected":
                pushSuccess?.(i18n.t("messages.vpn_connected", "VPN connected"));
                break;
              case "snack:disconnected":
                pushSuccess?.(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
                break;
              case "snack:cancelled":
                // BUG-A2: the user cancelled a connect/recovery before it became a live tunnel —
                // a distinct «Подключение отменено» toast (not the neutral «VPN отключён», which
                // reads as "your working VPN dropped"). Mirrors snack:disconnected → pushSuccess.
                pushSuccess?.(i18n.t("messages.connect_cancelled", "Connection cancelled"));
                break;
              case "snack:error":
                // F16: localize the core's fixed error phrase; empty payload → the localized generic
                // errors.connection_failed (ru source + en mirror), NOT an English default.
                pushSuccess?.(
                  localizeError(event.payload.error) || i18n.t("errors.connection_failed"),
                  "error",
                );
                break;
              case "consume-switch-superseded":
                // F-7: consume the one-shot supersede flag so a later real connect failure still
                // shows red. The reducer decided the neutral-vs-red routing; the ref clear is the
                // wiring-side mutation (refs never live inside the pure reducer).
                if (switchSupersededRef) switchSupersededRef.current = false;
                break;
              case "consume-connect-cancelled":
                // BUG-A2 F1: consume the one-shot connect-cancel flag on the terminal edge (the
                // reducer decided the cancel-vs-disconnect routing; the ref clear is the wiring-side
                // mutation). Draining it on connected/error too stops a cancel that raced past the
                // disconnect from mislabelling the NEXT disconnect.
                if (connectCancelledRef) connectCancelledRef.current = false;
                break;
            }
          }

          return nextStatus;
        });

        // Phase 14 (14-04 / Pitfall 2): DEFENSIVE isSwitching clear on the TERMINAL edge. A switch
        // settles on exactly two outcomes — `connected` (B is up) or `error` (B failed → the App
        // reverts to A). Fire onSettled here so the App's isSwitching lock is released even if a
        // switch promise was abandoned. Placed on the terminal-edge branch OUTSIDE the no-dwell
        // guard on purpose (broadening the guard risks swallowing a real terminal disconnect —
        // AUDIT #8 stuck-on-yellow). A bare `disconnected` is the switch's TRANSIENT teardown, not
        // a settle, so it deliberately does NOT fire onSettled.
        if (event.payload.status === "connected" || event.payload.status === "error") {
          onSettled?.(event.payload.status);
        }
        if (event.payload.error) {
          // Localize a stable reason code (e.g. `connect-timeout`) to a friendly message; non-code
          // errors pass through unchanged (SAFETY-03).
          setError(localizeError(event.payload.error));
        } else if (event.payload.status === "disconnected" || event.payload.status === "connecting") {
          // F3: a clean/terminal "disconnected" OR a fresh «Подключение» carries no error — clear
          // any stale banner so the badge and the banner never disagree. recovering/reconnecting are
          // intentionally NOT cleared here (they carry their own internet-status banner);
          // "connected" already clears it above (WR-01).
          setError(null);
        }
      },
    );
    unlistenStatus.then((f) => {
      if (cancelled) {
        // Effect was already torn down — unlisten the just-resolved listener immediately so it
        // can't survive into the next mount.
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
}
