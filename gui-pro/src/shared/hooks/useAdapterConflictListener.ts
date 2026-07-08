import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { ADAPTER_CONFLICT_EVENT, type AdapterConflictEvent } from "../ipc/events";

// Phase 17 (17-05, CA-1 + PA-1 FE consumer) — the `vpn-adapter-conflict` listener, split out of
// useVpnEvents and RETYPED onto the typed AdapterConflictEvent from shared/ipc/events.ts.
//
// PA-1 (Pitfall 2): the Rust producer (commands/vpn.rs AdapterConflictPayload) is a typed serde
// struct with a byte-identity round-trip test; THIS is the consumer side — the listener consumes
// the mirrored `AdapterConflictEvent` interface instead of an inline shape.
//
// T-34 (Phase 16): this listener writes a trace line to the Log Panel AND lifts the payload into
// React state (setConflict, when wired) so the «Подключение» tab can render the yellow second-VPN
// ErrorBanner. The payload's `adapters` are already own-adapter-filtered Rust-side (T-21), so
// anything here is a genuinely foreign VPN.

interface UseAdapterConflictListenerParams {
  setConflict?: (conflict: { adapters: string[]; message: string } | null) => void;
  traceLog: (msg: string) => void;
}

export function useAdapterConflictListener({
  setConflict,
  traceLog,
}: UseAdapterConflictListenerParams) {
  useEffect(() => {
    const unlisten = listen<AdapterConflictEvent>(
      ADAPTER_CONFLICT_EVENT,
      (event) => {
        const { adapters, message } = event.payload;
        traceLog(`WARNING: Conflicting adapters detected: ${adapters.join(", ")}. If connection fails, disable them.`);
        setConflict?.({ adapters, message });
      },
    );
    return () => { unlisten.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
