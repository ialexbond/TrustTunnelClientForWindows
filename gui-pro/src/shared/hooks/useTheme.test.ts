// Phase 13 (13-06) regression tests — the FE→Rust plate-theme mirror (review #13).
//
// The notification plate is a separate webview with its OWN empty localStorage, so it can never
// read the app theme itself; `useTheme` mirrors the EFFECTIVE theme into the Rust plate-theme cell
// (`set_plate_theme`) on mount and on every change, and notify::maybe_fire threads it into the
// plate payload. This exact link was behind the UAT round-2 defect (dark plate on the light app
// theme) and had zero test assertions — these lock it, mirroring the useAppSettings
// `set_notifications_enabled` mirror-test pattern (vi.mocked(invoke) from the shared tauri-mock).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "../../test/tauri-mock";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "./useTheme";

// `../../test/tauri-mock` replaces `@tauri-apps/api/core` `invoke` with a vi.fn() — grab the typed
// mock so the plate-theme mirror pushes can be asserted.
const mockInvoke = vi.mocked(invoke);

/** Flush useTheme's deferred effective-theme recompute (the mode effect defers via setTimeout(0)). */
function flushDeferredTheme() {
  act(() => {
    vi.advanceTimersByTime(0);
  });
}

describe("useTheme — FE→Rust plate-theme mirror (set_plate_theme)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    mockInvoke.mockClear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("mirrors the effective theme into Rust ONCE on mount", () => {
    // Empty storage → mode "system"; the test-setup matchMedia stub always resolves light.
    renderHook(() => useTheme());
    flushDeferredTheme();

    expect(mockInvoke).toHaveBeenCalledWith("set_plate_theme", { theme: "light" });
    // Exactly one mount push (the deferred recompute resolves the SAME theme → no re-push).
    const pushes = mockInvoke.mock.calls.filter((c) => c[0] === "set_plate_theme");
    expect(pushes).toHaveLength(1);
  });

  it("mirrors the STORED effective theme on mount (dark)", () => {
    // The plate must be correct from the very first fire — the mount push carries the persisted
    // theme, not a hardcoded default (the round-2 defect was exactly a stale plate theme).
    localStorage.setItem("tt_theme", "dark");
    renderHook(() => useTheme());
    flushDeferredTheme();

    expect(mockInvoke).toHaveBeenCalledWith("set_plate_theme", { theme: "dark" });
  });

  it("re-pushes set_plate_theme when the theme changes (light → dark)", () => {
    const { result } = renderHook(() => useTheme());
    flushDeferredTheme();
    mockInvoke.mockClear(); // drop the mount push so we assert only the change-path push

    act(() => {
      result.current.handleThemeChange("dark");
    });
    flushDeferredTheme(); // the mode effect defers setTheme via setTimeout(0)

    expect(mockInvoke).toHaveBeenCalledWith("set_plate_theme", { theme: "dark" });
  });
});
