import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface HostKeyPayload {
  host: string;
  fingerprint: string;
}

export function useHostKeyVerification() {
  const [pending, setPending] = useState<HostKeyPayload | null>(null);

  useEffect(() => {
    const unlisten = listen<HostKeyPayload>("ssh-host-key-verify", (event) => {
      setPending(event.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const respond = useCallback(async (accepted: boolean) => {
    await invoke("confirm_host_key", { accepted });
    setPending(null);
  }, []);

  return { pending, respond };
}
