import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { i18n as I18nType } from "i18next";
import { INTERNET_STATUS_EVENT, type InternetStatusEvent } from "../ipc/events";

// Phase 17 (17-05, CA-1 + PA-1 FE consumer) — the `internet-status` listener, split out of
// useVpnEvents and RETYPED onto the typed InternetStatusEvent from shared/ipc/events.ts.
//
// PA-1 (Pitfall 2): the Rust producer (connectivity.rs) is already a typed serde struct
// (InternetStatusPayload) with a byte-identity round-trip test; THIS is the consumer side of the
// same contract — the listener now consumes the mirrored `InternetStatusEvent` interface instead
// of an inline shape, so a field rename on either end fails a test instead of silently killing
// banner routing.
//
// STATUS-05 / D-01 / Pitfall 2: the window-independent Rust reconnect supervisor
// (connectivity.rs start_reconnect_supervisor) is the SOLE owner of auto-reconnect. This handler
// only enriches the user-facing MESSAGE (setError). It MUST NEVER set the status and MUST NEVER
// invoke the connect command — Rust owns BOTH. The old `action === "reconnect"` FE-driven branch
// is gone (Open Q2, deleted with the Rust supervisor). The old `disconnect` branch's
// setStatus("recovering") is also gone (02-20 STATUS CONFLICT FIX): the vpn-status event is the
// single status owner (D-01); this handler branches on `reason` only to pick the right banner
// text (tunnel-lost → server-lost, internet-lost → internet-lost).

interface UseInternetStatusListenerParams {
  i18n: I18nType;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  traceLog: (msg: string) => void;
}

export function useInternetStatusListener({
  i18n,
  setError,
  traceLog,
}: UseInternetStatusListenerParams) {
  useEffect(() => {
    const unlistenInternet = listen<InternetStatusEvent>(
      INTERNET_STATUS_EVENT,
      async (event) => {
        const { online, action, reason } = event.payload;
        traceLog(`event: online=${online}, action=${action ?? "none"}${reason ? `, reason=${reason}` : ""}`);

        if (!online && action === "disconnect") {
          // WR-01: the backend fires this SAME `disconnect` event for BOTH drop types and tags them
          // via `reason` (declare_offline_and_handoff sets `tunnel-lost` for a server-silent drop,
          // `internet-lost` for a local-net loss). Branch on the reason so the banner matches the
          // authoritative status the vpn-status event sets (D-01 still owns status). The banner is
          // the SINGLE source of this sentence — StatusPanel's reconnecting sub-text renders ONLY the
          // «Попытка N/N» counter so the two never duplicate the same line.
          traceLog("Connectivity lost — Rust supervisor is recovering the connection...");
          setError(
            reason === "tunnel-lost"
              ? i18n.t("errors.server_connection_lost")
              : i18n.t("errors.internet_lost_disconnecting"),
          );
        } else if (!online && action === "give_up") {
          // Backend gave up waiting for the adapter. We surface the friendly message; the terminal
          // STATUS (error) arrives via the vpn-status event carrying the `recovery-timeout` reason
          // code — we do NOT force a status here.
          traceLog("Gave up waiting for network recovery");
          setError(i18n.t("errors.network_recovery_timeout"));
        }
        // The `reconnect` action is intentionally NOT handled here anymore — Rust owns reconnect
        // (Pitfall 2 / Open Q2). The backend's terminal outcome (recovered / reconnect-gave-up /
        // recovery-timeout Error) arrives via the vpn-status listener, the single status owner (D-01).
      },
    );
    return () => { unlistenInternet.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n, setError]);
}
