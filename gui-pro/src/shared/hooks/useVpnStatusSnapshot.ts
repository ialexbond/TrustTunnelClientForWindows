import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { VpnStatus } from "../types";

// Phase 17 (17-05, CA-1) — the mount-time VPN status snapshot, split out of useVpnEvents.
//
// A window that mounts AFTER a status change (e.g. mid-reconnect, or after an error) must
// recover BOTH the status AND its reason. check_vpn_status_full returns the same { status,
// error } shape as the live "vpn-status" event, so a late-mounting window renders the correct
// label + banner. This is an independent async channel from the live listener; AUDIT #14 gates
// the snapshot write behind `sawLiveStatusEventRef` (a live event is always strictly newer).

interface UseVpnStatusSnapshotParams {
  setStatus: React.Dispatch<React.SetStateAction<VpnStatus>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setConnectedSince: React.Dispatch<React.SetStateAction<Date | null>>;
  sawLiveStatusEventRef: React.MutableRefObject<boolean>;
  localizeError: (error: string | null | undefined) => string | null;
}

export function useVpnStatusSnapshot({
  setStatus,
  setError,
  setConnectedSince,
  sawLiveStatusEventRef,
  localizeError,
}: UseVpnStatusSnapshotParams) {
  useEffect(() => {
    // Codex MEDIUM: a window that mounts AFTER an `error` event must recover BOTH the status AND
    // its reason. check_vpn_status_full returns the same { status, error } shape as the
    // "vpn-status" event (the backend persists last_error alongside vpn_status), so we restore the
    // reason here too. `error` is the already-sanitized backend string (D-29) — never a raw secret.
    invoke<{ status: VpnStatus; error: string | null }>("check_vpn_status_full")
      .then(({ status, error }) => {
        // AUDIT-2026-06-11 #14: a live vpn-status event already arrived while this IPC reply was in
        // flight — the event is strictly newer than the snapshot, so applying the snapshot now would
        // roll the status BACK (e.g. connected → reconnecting, permanently, since a settled backend
        // emits nothing further). Drop the stale snapshot entirely (status AND its error payload).
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
          // Plan 02-08 (T-08-02): a window mounting mid-reconnect must render the recovering/
          // reconnecting label from the snapshot, not fall through to "disconnected". 02-20:
          // «Восстановление» (recovering) and «Переподключение» (reconnecting) are distinct snapshot
          // states; both mean the session is NOT up, so connectedSince is cleared for either.
          setStatus(status);
          setConnectedSince(null);
        } else if (status === "disconnecting") {
          // F-9 (Fable-5): a window mounting mid-teardown (the 3.4 Disconnecting transient can be in
          // flight up to ~7s under 3.2) must render «Отключение», not collapse to «Отключено».
          setStatus("disconnecting");
          setConnectedSince(null);
        } else {
          setStatus("disconnected");
          setConnectedSince(null);
        }
        // Restore the reason whenever the snapshot carries one (an error that fired before this
        // window finished mounting). Localize a known reason code so a late-mounting window also
        // shows the friendly message, not the raw code.
        if (error) {
          setError(localizeError(error));
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setStatus, setError, setConnectedSince]);
}
