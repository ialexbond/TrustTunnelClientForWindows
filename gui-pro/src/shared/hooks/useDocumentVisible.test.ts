import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDocumentVisible } from "./useDocumentVisible";

/**
 * useDocumentVisible — the single shared poller-gating hook (Plan 09-19, QE-05).
 * Returns `!document.hidden` and re-renders on every `visibilitychange`. The
 * Overview interval pollers fold its value into their enabled/guard so they
 * pause when the window is hidden (the reboot poller is the documented exception
 * — see OverviewSection).
 */

// Helper: drive document.hidden + dispatch the visibilitychange event the same
// way a real tab-switch / minimize does.
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

afterEach(() => {
  // Reset to visible so tests don't leak hidden state into each other.
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

describe("useDocumentVisible", () => {
  it("returns true when the document is visible on mount", () => {
    setHidden(false);
    const { result } = renderHook(() => useDocumentVisible());
    expect(result.current).toBe(true);
  });

  it("returns false when the document is hidden on mount", () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    const { result } = renderHook(() => useDocumentVisible());
    expect(result.current).toBe(false);
  });

  it("flips false when the document becomes hidden, and back to true when visible", () => {
    setHidden(false);
    const { result } = renderHook(() => useDocumentVisible());
    expect(result.current).toBe(true);

    setHidden(true);
    expect(result.current).toBe(false);

    setHidden(false);
    expect(result.current).toBe(true);
  });

  it("unsubscribes from visibilitychange on unmount (no leak)", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useDocumentVisible());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    removeSpy.mockRestore();
  });
});
