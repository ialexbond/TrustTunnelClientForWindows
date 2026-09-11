import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useDeepLinkImport } from "./useDeepLinkImport";
import { captureListeners } from "../../test/fixtures/events";

// `@tauri-apps/api/event` listen + `@tauri-apps/api/core` invoke are globally
// mocked in src/test/tauri-mock.ts. captureListeners re-points listen at an
// in-memory registry so we can drive the `deep-link-url` event; we set the
// invoke mock per-test to drive the startup `poll_pending_deeplink`.

describe("useDeepLinkImport (06-18 C-22/D-14)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: startup poll finds nothing pending.
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("sets pendingUrl when a deep-link-url event fires", async () => {
    const events = captureListeners();

    const { result } = renderHook(() => useDeepLinkImport());
    expect(events.count("deep-link-url")).toBe(1);
    // flush the startup poll (resolves null) before asserting the event path
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.pendingUrl).toBeNull();

    await act(async () => {
      events.emitEvent("deep-link-url", { url: "tt://?ZmFrZQ" });
    });

    expect(result.current.pendingUrl).toBe("tt://?ZmFrZQ");
  });

  it("sets pendingUrl when poll_pending_deeplink returns a URL on mount", async () => {
    captureListeners();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "poll_pending_deeplink") return "trusttunnel://abc";
      return null;
    });

    const { result } = renderHook(() => useDeepLinkImport());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.pendingUrl).toBe("trusttunnel://abc");
  });

  it("leaves pendingUrl null when poll_pending_deeplink returns null", async () => {
    captureListeners();
    vi.mocked(invoke).mockResolvedValue(null);

    const { result } = renderHook(() => useDeepLinkImport());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.pendingUrl).toBeNull();
  });

  it("consume() clears pendingUrl", async () => {
    const events = captureListeners();

    const { result } = renderHook(() => useDeepLinkImport());
    await act(async () => {
      events.emitEvent("deep-link-url", { url: "tt://?x" });
    });
    expect(result.current.pendingUrl).toBe("tt://?x");

    act(() => {
      result.current.consume();
    });
    expect(result.current.pendingUrl).toBeNull();
  });

  it("does not re-apply the same URL twice (idempotent)", async () => {
    const events = captureListeners();

    const { result } = renderHook(() => useDeepLinkImport());
    await act(async () => {
      events.emitEvent("deep-link-url", { url: "tt://?same" });
    });
    expect(result.current.pendingUrl).toBe("tt://?same");

    // Consume, then a duplicate event of the SAME url re-fires — it must still set
    // it back (consume cleared it, so it is "different" again and re-applies).
    act(() => {
      result.current.consume();
    });
    await act(async () => {
      events.emitEvent("deep-link-url", { url: "tt://?same" });
    });
    expect(result.current.pendingUrl).toBe("tt://?same");
  });

  it("unsubscribes on unmount (no leaked listener)", async () => {
    const events = captureListeners();

    const { unmount } = renderHook(() => useDeepLinkImport());
    expect(events.count("deep-link-url")).toBe(1);

    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(events.count("deep-link-url")).toBe(0);
  });
});
