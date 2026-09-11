import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";

export type ActivityTag = "STATE" | "USER" | "PROTO" | "ERROR";

export function useActivityLog() {
  const log = useCallback(
    (tag: ActivityTag, message: string, details?: string) => {
      // Fire-and-forget — Activity Log must not block UI
      invoke("write_activity_log", { tag, message, details }).catch(() => {
        // Silent fail — logging failure must not affect UX
      });
    },
    []
  );

  return { log };
}
