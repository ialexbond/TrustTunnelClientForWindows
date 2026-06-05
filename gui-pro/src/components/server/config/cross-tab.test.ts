import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRulesTomlChanged } from "../../../shared/hooks/useRulesTomlChanged";

// Mock @tauri-apps/api/event
const mockUnlisten = vi.fn();
let capturedHandler: ((event: { payload: { file: string } }) => void) | null = null;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (eventName: string, handler: (event: { payload: { file: string } }) => void) => {
      if (eventName === "rules-toml-changed") {
        capturedHandler = handler;
      }
      return Promise.resolve(mockUnlisten);
    },
  ),
}));

describe("useRulesTomlChanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandler = null;
  });

  it("subscribes to rules-toml-changed via listen() on mount (REQ-15.8)", async () => {
    const onChanged = vi.fn();
    renderHook(() => useRulesTomlChanged(onChanged));
    // Allow microtask to resolve listen() promise
    await Promise.resolve();
    expect(capturedHandler).not.toBeNull();
  });

  it("callback fires когда payload.file === 'rules.toml' (REQ-15.8)", async () => {
    const onChanged = vi.fn();
    renderHook(() => useRulesTomlChanged(onChanged));
    await Promise.resolve();
    // Simulate event delivery
    if (capturedHandler) capturedHandler({ payload: { file: "rules.toml" } });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("callback does NOT fire для other file payloads", async () => {
    const onChanged = vi.fn();
    renderHook(() => useRulesTomlChanged(onChanged));
    await Promise.resolve();
    if (capturedHandler) capturedHandler({ payload: { file: "vpn.toml" } });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("listen() unsubscribed on unmount (cleanup)", async () => {
    const onChanged = vi.fn();
    const { unmount } = renderHook(() => useRulesTomlChanged(onChanged));
    await Promise.resolve();
    unmount();
    // Allow cleanup microtask
    await Promise.resolve();
    expect(mockUnlisten).toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 3 gap-fill: cross-tab → reloadBundle integration (REQ-15.8)
  // ════════════════════════════════════════════════════════════════════════

  it("each rules-toml-changed event invokes the consumer's reloadBundle callback", async () => {
    // Integration view: the consuming tab passes a reloadBundle()-style callback
    // (re-fetch the config bundle). Every matching event must invoke it so the
    // other tab's cached view is invalidated.
    const reloadBundle = vi.fn();
    renderHook(() => useRulesTomlChanged(reloadBundle));
    await Promise.resolve();
    expect(capturedHandler).not.toBeNull();

    capturedHandler!({ payload: { file: "rules.toml" } });
    capturedHandler!({ payload: { file: "rules.toml" } });
    // Two events → two reloads; non-matching files are ignored in between.
    capturedHandler!({ payload: { file: "vpn.toml" } });
    capturedHandler!({ payload: { file: "rules.toml" } });

    expect(reloadBundle).toHaveBeenCalledTimes(3);
  });
});
