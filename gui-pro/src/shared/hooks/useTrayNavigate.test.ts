import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTrayNavigate } from "./useTrayNavigate";
import { captureListeners } from "../../test/fixtures/events";

// `@tauri-apps/api/event` listen is globally mocked in src/test/tauri-mock.ts;
// captureListeners re-points the mock at an in-memory registry so we can drive
// the `tray-navigate` event and assert the callback / unlisten behavior.

describe("useTrayNavigate (06-17 C-26)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes onNavigate with the payload target when tray-navigate fires", async () => {
    const events = captureListeners();
    const onNavigate = vi.fn();

    renderHook(() => useTrayNavigate(onNavigate));

    // The hook registered exactly one listener for the event.
    expect(events.count("tray-navigate")).toBe(1);

    await act(async () => {
      events.emitEvent("tray-navigate", { target: "install" });
    });

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("install");
  });

  it("unsubscribes on unmount (no leaked listener)", async () => {
    const events = captureListeners();
    const onNavigate = vi.fn();

    const { unmount } = renderHook(() => useTrayNavigate(onNavigate));
    expect(events.count("tray-navigate")).toBe(1);

    // Unmount triggers the then(unlisten) cleanup which removes the callback
    // from the registry. The unlisten is async, so flush microtasks.
    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(events.count("tray-navigate")).toBe(0);

    // A late emit after unmount must not reach the (now removed) callback.
    events.emitEvent("tray-navigate", { target: "install" });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
