import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "../../test/tauri-mock";
import { invoke } from "@tauri-apps/api/core";
import {
  useAppSettings,
  APP_SETTINGS_DEFAULTS,
  AUTO_SWITCH_BOUNDS,
  APP_SETTINGS_KEYS,
} from "./useAppSettings";

// `../../test/tauri-mock` replaces `@tauri-apps/api/core` `invoke` with a vi.fn() — grab the typed
// mock so Phase 13 can assert the Rust master-gate mirror pushes (set_notifications_enabled).
const mockInvoke = vi.mocked(invoke);

describe("useAppSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockClear();
  });

  // ─── Locked defaults on empty storage (Pattern 4) ───
  it("loads locked defaults on empty storage", () => {
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings).toEqual({
      masterOn: false,
      thresholdMs: 300,
      intervalSec: 15,
      checksN: 3,
      autoConnectOnLaunch: true,
      notificationsOn: true,
    });
  });

  it("exposes the locked default constants for 12-05/12-06 to import (no drift)", () => {
    expect(APP_SETTINGS_DEFAULTS).toEqual({
      masterOn: false,
      thresholdMs: 300,
      intervalSec: 15,
      checksN: 3,
      autoConnectOnLaunch: true,
      notificationsOn: true,
    });
  });

  it("exposes the locked clamp bounds for 12-05/12-06 to import (no drift)", () => {
    expect(AUTO_SWITCH_BOUNDS).toEqual({
      thresholdMs: { min: 150, max: 5000 },
      intervalSec: { min: 5, max: 300 },
      checksN: { min: 1, max: 10 },
    });
  });

  // ─── A3: autoConnectOnLaunch reuses the EXISTING tt_auto_connect key ───
  it("reads autoConnectOnLaunch from the existing tt_auto_connect key", () => {
    localStorage.setItem("tt_auto_connect", "false");
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings.autoConnectOnLaunch).toBe(false);
  });

  it("writes autoConnectOnLaunch back to the existing tt_auto_connect key (no second key)", () => {
    const { result } = renderHook(() => useAppSettings());

    act(() => {
      result.current.setAutoConnectOnLaunch(false);
    });

    expect(localStorage.getItem("tt_auto_connect")).toBe("false");
    expect(result.current.settings.autoConnectOnLaunch).toBe(false);
    // key map must point at the existing key, never a fork
    expect(APP_SETTINGS_KEYS.autoConnectOnLaunch).toBe("tt_auto_connect");
  });

  // ─── Each setter persists immediately + updates state ───
  it("setMasterOn persists and updates state", () => {
    const { result } = renderHook(() => useAppSettings());
    act(() => {
      result.current.setMasterOn(true);
    });
    expect(result.current.settings.masterOn).toBe(true);
    expect(localStorage.getItem(APP_SETTINGS_KEYS.masterOn)).toBe("true");
  });

  it("setNotificationsOn persists a real boolean Phase 13 will read", () => {
    const { result } = renderHook(() => useAppSettings());
    act(() => {
      result.current.setNotificationsOn(false);
    });
    expect(result.current.settings.notificationsOn).toBe(false);
    expect(localStorage.getItem(APP_SETTINGS_KEYS.notificationsOn)).toBe(
      "false",
    );
  });

  // ─── Phase 13 (D-06 / §C): mirror the master toggle into the Rust gate ───
  it("mirrors the notifications toggle into Rust on change (set_notifications_enabled)", () => {
    const { result } = renderHook(() => useAppSettings());
    mockInvoke.mockClear(); // drop the startup mirror push so we assert only the change-path push
    act(() => {
      result.current.setNotificationsOn(false);
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_notifications_enabled", {
      enabled: false,
    });
    act(() => {
      result.current.setNotificationsOn(true);
    });
    expect(mockInvoke).toHaveBeenLastCalledWith("set_notifications_enabled", {
      enabled: true,
    });
  });

  it("mirrors the persisted notifications value into Rust ONCE at startup", () => {
    // Persist OFF, then mount: the startup effect must push the saved value to the Rust gate so
    // the gate is correct before the first in-session toggle (the Rust pre-seed is `true`).
    localStorage.setItem(APP_SETTINGS_KEYS.notificationsOn, "false");
    renderHook(() => useAppSettings());
    expect(mockInvoke).toHaveBeenCalledWith("set_notifications_enabled", {
      enabled: false,
    });
    // Exactly one startup mirror push (no re-push on every render).
    const startupPushes = mockInvoke.mock.calls.filter(
      (c) => c[0] === "set_notifications_enabled",
    );
    expect(startupPushes).toHaveLength(1);
  });

  it("setThresholdMs / setIntervalSec / setChecksN persist in-range values", () => {
    const { result } = renderHook(() => useAppSettings());
    act(() => {
      result.current.setThresholdMs(450);
      result.current.setIntervalSec(30);
      result.current.setChecksN(5);
    });
    expect(result.current.settings.thresholdMs).toBe(450);
    expect(result.current.settings.intervalSec).toBe(30);
    expect(result.current.settings.checksN).toBe(5);
    expect(localStorage.getItem(APP_SETTINGS_KEYS.thresholdMs)).toBe("450");
    expect(localStorage.getItem(APP_SETTINGS_KEYS.intervalSec)).toBe("30");
    expect(localStorage.getItem(APP_SETTINGS_KEYS.checksN)).toBe("5");
  });

  // ─── V5: out-of-range stored values are clamped on read ───
  it("clamps a stored thresholdMs above the max to 5000", () => {
    localStorage.setItem(APP_SETTINGS_KEYS.thresholdMs, "999999");
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings.thresholdMs).toBe(5000);
  });

  it("clamps a stored thresholdMs below the min to 150", () => {
    localStorage.setItem(APP_SETTINGS_KEYS.thresholdMs, "0");
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings.thresholdMs).toBe(150);
  });

  it("clamps a stored intervalSec below the min to 5 (no tight ping-storm — T-12-05)", () => {
    localStorage.setItem(APP_SETTINGS_KEYS.intervalSec, "0");
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings.intervalSec).toBe(5);
  });

  it("clamps a stored intervalSec above the max to 300", () => {
    localStorage.setItem(APP_SETTINGS_KEYS.intervalSec, "99999");
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings.intervalSec).toBe(300);
  });

  it("clamps a stored checksN out of range to its bounds", () => {
    localStorage.setItem(APP_SETTINGS_KEYS.checksN, "0");
    const { result: low } = renderHook(() => useAppSettings());
    expect(low.current.settings.checksN).toBe(1);

    localStorage.setItem(APP_SETTINGS_KEYS.checksN, "100");
    const { result: high } = renderHook(() => useAppSettings());
    expect(high.current.settings.checksN).toBe(10);
  });

  it("clamps a setter value above the max before persisting (V5 on write too)", () => {
    const { result } = renderHook(() => useAppSettings());
    act(() => {
      result.current.setThresholdMs(999999);
    });
    expect(result.current.settings.thresholdMs).toBe(5000);
    expect(localStorage.getItem(APP_SETTINGS_KEYS.thresholdMs)).toBe("5000");
  });

  // ─── T-12-06: corrupt / non-numeric stored value falls back to default (no throw, no NaN) ───
  it("falls back to the default when a stored number is non-numeric", () => {
    localStorage.setItem(APP_SETTINGS_KEYS.thresholdMs, "not-a-number");
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings.thresholdMs).toBe(300);
    expect(Number.isNaN(result.current.settings.thresholdMs)).toBe(false);
  });

  it("falls back to defaults for every numeric pref when corrupt", () => {
    localStorage.setItem(APP_SETTINGS_KEYS.thresholdMs, "xxx");
    localStorage.setItem(APP_SETTINGS_KEYS.intervalSec, "");
    localStorage.setItem(APP_SETTINGS_KEYS.checksN, "NaN");
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings.thresholdMs).toBe(300);
    expect(result.current.settings.intervalSec).toBe(15);
    expect(result.current.settings.checksN).toBe(3);
  });

  it("loads previously-persisted in-range values on init", () => {
    localStorage.setItem(APP_SETTINGS_KEYS.masterOn, "true");
    localStorage.setItem(APP_SETTINGS_KEYS.thresholdMs, "200");
    localStorage.setItem(APP_SETTINGS_KEYS.notificationsOn, "false");
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings.masterOn).toBe(true);
    expect(result.current.settings.thresholdMs).toBe(200);
    expect(result.current.settings.notificationsOn).toBe(false);
  });

  // ─── CR-01: two independent instances stay in sync within the same document ───
  // REGRESSION-FIRST: before the same-document broadcast fix, instance B's value did NOT update
  // when instance A wrote — App.tsx's engine instance never saw an in-session toggle from
  // AutoModeSettings. These assert a change in ONE instance reaches the OTHER WITHOUT a remount.
  it("propagates a master-toggle change from one instance to another live instance", () => {
    const a = renderHook(() => useAppSettings());
    const b = renderHook(() => useAppSettings());

    expect(a.result.current.settings.masterOn).toBe(false);
    expect(b.result.current.settings.masterOn).toBe(false);

    act(() => {
      a.result.current.setMasterOn(true);
    });

    // Instance A obviously updated; the BROKEN behavior was instance B staying stale.
    expect(a.result.current.settings.masterOn).toBe(true);
    expect(b.result.current.settings.masterOn).toBe(true);
  });

  it("propagates numeric param changes to a second live instance", () => {
    const a = renderHook(() => useAppSettings());
    const b = renderHook(() => useAppSettings());

    act(() => {
      a.result.current.setThresholdMs(450);
      a.result.current.setIntervalSec(30);
      a.result.current.setChecksN(5);
    });

    expect(b.result.current.settings.thresholdMs).toBe(450);
    expect(b.result.current.settings.intervalSec).toBe(30);
    expect(b.result.current.settings.checksN).toBe(5);
  });
});
