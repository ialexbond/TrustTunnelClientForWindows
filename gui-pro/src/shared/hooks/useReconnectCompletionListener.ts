import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { VpnStatus } from "../types";

// Phase 17 (17-05, CA-1) — the reconnect-completion `vpn-status` listener, split out of
// useVpnEvents. A SECOND vpn-status listener (distinct from the primary status listener) whose
// only job is to resolve the pending `reconnectResolve` promise on a `disconnected` edge, so a
// manual «Сохранить и переподключить» flow can await the teardown before re-connecting. It shows
// NO snackbar and touches NO status — it only fulfils the latch. Same async-unlisten StrictMode
// hardening as the primary listener (D-08).

interface UseReconnectCompletionListenerParams {
  reconnectResolve: React.MutableRefObject<(() => void) | null>;
}

export function useReconnectCompletionListener({
  reconnectResolve,
}: UseReconnectCompletionListenerParams) {
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
}
