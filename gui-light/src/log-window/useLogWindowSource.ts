import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LogEntry } from "../shared/types";

// The ONLY event channel the dev log window subscribes to (Light mirror of Pro).
//
// D-29 (CRITICAL): `vpn-log` is the already-sanitized stream — every line is
// passed through `logging::sanitize` in the Rust backend before it is emitted,
// so it provably cannot carry a password or secret. The dev log window MUST NOT
// open any other (raw) channel.
export const LOG_WINDOW_SOURCE_EVENT = "vpn-log" as const;

const MAX_BUFFER = 1000;

interface VpnLogPayload {
  message: string;
  level?: string;
}

function nowTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// Aggregated dev log source. Subscribes ONLY to the sanitized `vpn-log` event,
// buffers up to MAX_BUFFER entries, and exposes them + a clear action. No new/raw
// channel is opened (D-29).
export function useLogWindowSource(): { logs: LogEntry[]; clear: () => void } {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    let resolvedUnlisten: (() => void) | null = null;
    const unlisten = listen<VpnLogPayload>(LOG_WINDOW_SOURCE_EVENT, (event) => {
      const msg = event.payload.message.trim();
      if (!msg) return;
      const level = event.payload.level ?? "info";
      setLogs((prev) => {
        const next = [...prev, { timestamp: nowTimestamp(), level, message: msg }];
        return next.length > MAX_BUFFER ? next.slice(-MAX_BUFFER) : next;
      });
    });
    unlisten.then((f) => {
      if (cancelled) f();
      else resolvedUnlisten = f;
    });
    return () => {
      cancelled = true;
      if (resolvedUnlisten) resolvedUnlisten();
    };
  }, []);

  const clear = () => setLogs([]);
  return { logs, clear };
}
