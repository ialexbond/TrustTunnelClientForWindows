import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface DeepLinkPayload {
  url: string;
}

/**
 * Deep-link config-import bridge (C-22 / D-14).
 *
 * Captures an incoming `tt://` / `trusttunnel://` URL from BOTH delivery
 * channels and surfaces it as a single `pendingUrl` the shell can route to the
 * import surface:
 *   1. the `deep-link-url` event — emitted by the single-instance handler (a
 *      second launch with a tt:// arg) AND by the backend startup poll
 *      (lib.rs setup, cold start launched by the link);
 *   2. a one-shot `invoke("poll_pending_deeplink")` on mount — drains a URL the
 *      protocol-handler launcher wrote BEFORE this listener attached (cold-start
 *      / file-poll race the event alone could miss).
 *
 * The hook mirrors `useHostKeyVerification` exactly (listen → unlisten cleanup,
 * useCallback consumer). It does NOT decode or validate the URL — it carries the
 * RAW, untrusted URL to `ImportConfigModal`, which routes it through the backend
 * `decode_deeplink` (the trusted validation boundary) only when the user clicks
 * «Импортировать». A malformed URL therefore cannot silently write a config.
 */
export function useDeepLinkImport() {
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  useEffect(() => {
    // Channel 1: the live event (single-instance arg + backend startup emit).
    const unlisten = listen<DeepLinkPayload>("deep-link-url", (event) => {
      const url = event.payload?.url;
      if (url) {
        // Idempotent: only set when different from the current pending value so a
        // poll-then-event double-delivery of the SAME URL is not applied twice.
        setPendingUrl((prev) => (prev === url ? prev : url));
      }
    });

    // Channel 2: drain a URL written before the listener attached (cold start /
    // file-poll race). Best-effort — a poll failure is non-fatal.
    invoke<string | null>("poll_pending_deeplink")
      .then((url) => {
        if (url) {
          setPendingUrl((prev) => (prev === url ? prev : url));
        }
      })
      .catch(() => {
        /* no pending URL / command unavailable — nothing to import */
      });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Called by the shell AFTER it has opened the import modal, so the same URL is
  // not re-applied on the next render. The shell keeps its own copy of the URL
  // for the modal's `initialUrl`, so clearing here is safe.
  const consume = useCallback(() => {
    setPendingUrl(null);
  }, []);

  return { pendingUrl, consume };
}
