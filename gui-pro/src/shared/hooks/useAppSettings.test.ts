import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "../../test/tauri-mock";
import { invoke } from "@tauri-apps/api/core";
import {
  useAppSettings,
  APP_SETTINGS_DEFAULTS,
  APP_SETTINGS_KEYS,
} from "./useAppSettings";

/**
 * 27 D-07 / plan 28-08: the three numeric auto-switch preferences — порог задержки, интервал
 * проверки, число проверок — are GONE from this store, together with `AUTO_SWITCH_BOUNDS` and their
 * three setters. They only ever configured the frontend latency engine this phase retires; failover
 * now fires on a real loss of the tunnel, which has nothing to tune.
 *
 * The keys already written to disk are ABANDONED, not purged (28-CONTEXT OQ-3, confirmed at the
 * plan's decision checkpoint): nothing reads them, so they are inert, and a migration that deletes
 * three dead entries can only fail loudly on somebody's machine for no gain. The test below is what
 * makes «abandoned» mean something — it proves a stored value for a removed key cannot resurface in
 * the returned object, which is the shape a half-removal would take.
 */
const REMOVED_KEYS = {
  thresholdMs: "tt_auto_switch_threshold_ms",
  intervalSec: "tt_auto_switch_interval_sec",
  checksN: "tt_auto_switch_checks",
} as const;

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
      autoConnectOnLaunch: true,
      notificationsOn: true,
      failoverExcludedIds: [],
    });
  });

  it("exposes the locked default constants for its consumers to import (no drift)", () => {
    expect(APP_SETTINGS_DEFAULTS).toEqual({
      masterOn: false,
      autoConnectOnLaunch: true,
      notificationsOn: true,
      failoverExcludedIds: [],
    });
  });

  // ─── 27 D-07: the three removed preferences are abandoned, not read ───
  //
  // `toEqual` above already fails if a removed field reappears on an EMPTY store. This one covers
  // the harder half: a machine that HAS the old values on disk. A half-removal — the field pulled
  // out of the interface but left in the read path, or a setter kept "just in case" — would show up
  // here as a resurrected value, and nowhere else.
  it("never resurfaces a stored value for a removed preference", () => {
    localStorage.setItem(REMOVED_KEYS.thresholdMs, "450");
    localStorage.setItem(REMOVED_KEYS.intervalSec, "30");
    localStorage.setItem(REMOVED_KEYS.checksN, "5");

    const { result } = renderHook(() => useAppSettings());

    // Not in the settings object under any name…
    const values = Object.values(result.current.settings);
    expect(values).not.toContain(450);
    expect(values).not.toContain(30);
    expect(values).not.toContain(5);
    expect(Object.keys(result.current.settings).sort()).toEqual([
      "autoConnectOnLaunch",
      "failoverExcludedIds",
      "masterOn",
      "notificationsOn",
    ]);
    // …no setter survives that could write them again…
    expect(Object.keys(result.current)).toEqual(
      expect.not.arrayContaining(["setThresholdMs", "setIntervalSec", "setChecksN"]),
    );
    // …and no key map entry points at them any more.
    expect(Object.values(APP_SETTINGS_KEYS)).toEqual(
      expect.not.arrayContaining(Object.values(REMOVED_KEYS)),
    );
    // ABANDONED, not purged: the stored values are still on disk, untouched.
    expect(localStorage.getItem(REMOVED_KEYS.thresholdMs)).toBe("450");
    expect(localStorage.getItem(REMOVED_KEYS.intervalSec)).toBe("30");
    expect(localStorage.getItem(REMOVED_KEYS.checksN)).toBe("5");
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

  it("loads previously-persisted values on init", () => {
    localStorage.setItem(APP_SETTINGS_KEYS.masterOn, "true");
    localStorage.setItem(APP_SETTINGS_KEYS.notificationsOn, "false");
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings.masterOn).toBe(true);
    expect(result.current.settings.notificationsOn).toBe(false);
  });

  // 27 D-07: `tt_auto_switch_enabled` is NOT renamed — it BECOMES the failover master. A user who
  // had auto-switch on months ago keeps failover on with no migration step, which is the whole
  // reason the key survived the rewrite.
  it("carries the stored master value over as the failover master (same key, no reset)", () => {
    localStorage.setItem("tt_auto_switch_enabled", "true");
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings.masterOn).toBe(true);
    expect(APP_SETTINGS_KEYS.masterOn).toBe("tt_auto_switch_enabled");
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

  // The CR-01 broadcast must survive the shrink: it is what keeps two live instances in step, and
  // the three numeric setters used to be half its coverage. `setNotificationsOn` stands in for them.
  it("propagates a notifications change to a second live instance", () => {
    const a = renderHook(() => useAppSettings());
    const b = renderHook(() => useAppSettings());

    act(() => {
      a.result.current.setNotificationsOn(false);
    });

    expect(b.result.current.settings.notificationsOn).toBe(false);
  });

  // ─── Phase 28 (27 D-06/D-08): mirror the failover preference into the Rust-readable store ───
  //
  // localStorage stays the UI-facing store, but the failover monitor runs in Rust with no window
  // open — it cannot read localStorage at all. Every write therefore has to reach
  // `set_failover_settings`, or the monitor silently obeys a stale preference and the failure looks
  // like «оно просто не переключается».

  it("mirrors the master toggle into Rust on change (set_failover_settings)", () => {
    const { result } = renderHook(() => useAppSettings());
    mockInvoke.mockClear(); // drop the startup seed so we assert only the change-path push
    act(() => {
      result.current.setMasterOn(true);
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_failover_settings", {
      enabled: true,
      excludedIds: [],
    });
  });

  it("mirrors the exclusion set into Rust on change, carrying the current master value with it", () => {
    localStorage.setItem(APP_SETTINGS_KEYS.masterOn, "true");
    const { result } = renderHook(() => useAppSettings());
    mockInvoke.mockClear();
    act(() => {
      result.current.setFailoverExcludedIds(["srv-1", "srv-2"]);
    });
    // Both fields move together — the Rust writer replaces the pair, so a push that dropped the
    // master value would switch failover off as a side effect of opting one server out.
    expect(mockInvoke).toHaveBeenCalledWith("set_failover_settings", {
      enabled: true,
      excludedIds: ["srv-1", "srv-2"],
    });
  });

  it("persists the exclusion set as a JSON array under tt_auto_switch_excluded_ids", () => {
    const { result } = renderHook(() => useAppSettings());
    act(() => {
      result.current.setFailoverExcludedIds(["srv-1"]);
    });
    expect(APP_SETTINGS_KEYS.failoverExcludedIds).toBe(
      "tt_auto_switch_excluded_ids",
    );
    expect(
      localStorage.getItem(APP_SETTINGS_KEYS.failoverExcludedIds),
    ).toBe('["srv-1"]');
    expect(result.current.settings.failoverExcludedIds).toEqual(["srv-1"]);
  });

  it("reads a persisted exclusion set back on mount", () => {
    localStorage.setItem(
      APP_SETTINGS_KEYS.failoverExcludedIds,
      '["srv-a","srv-b"]',
    );
    const { result } = renderHook(() => useAppSettings());
    expect(result.current.settings.failoverExcludedIds).toEqual([
      "srv-a",
      "srv-b",
    ]);
  });

  it("falls back to an empty exclusion set when the stored value is corrupt or not an array", () => {
    // Same defensive posture as the numeric readers (T-12-06): a corrupt value must never throw
    // out of the lazy initializer, which would take the whole Settings tab down on mount.
    localStorage.setItem(APP_SETTINGS_KEYS.failoverExcludedIds, "{ not json");
    const { result: corrupt } = renderHook(() => useAppSettings());
    expect(corrupt.current.settings.failoverExcludedIds).toEqual([]);

    localStorage.setItem(APP_SETTINGS_KEYS.failoverExcludedIds, '{"a":1}');
    const { result: notAnArray } = renderHook(() => useAppSettings());
    expect(notAnArray.current.settings.failoverExcludedIds).toEqual([]);
  });

  it("does not throw or roll back the stored value when the Rust mirror write is rejected", async () => {
    const { result } = renderHook(() => useAppSettings());
    mockInvoke.mockClear();
    mockInvoke.mockRejectedValueOnce(new Error("no backend"));

    expect(() => {
      act(() => {
        result.current.setMasterOn(true);
      });
    }).not.toThrow();

    // Let the rejection settle inside the swallow — an unhandled rejection here would fail the run.
    await act(async () => {
      await Promise.resolve();
    });

    // The value the user sees is the localStorage one. A failed mirror must not make the toggle
    // appear to bounce back; the next successful write re-syncs Rust.
    expect(result.current.settings.masterOn).toBe(true);
    expect(localStorage.getItem(APP_SETTINGS_KEYS.masterOn)).toBe("true");
  });

  it("seeds the Rust-readable failover copy ONCE at startup from the persisted values", () => {
    // An install upgrading from a build that never wrote app_settings.json would otherwise sit on
    // the Rust-side default (OFF) while the UI showed the user's saved ON.
    localStorage.setItem(APP_SETTINGS_KEYS.masterOn, "true");
    localStorage.setItem(APP_SETTINGS_KEYS.failoverExcludedIds, '["srv-1"]');

    renderHook(() => useAppSettings());

    const seeds = mockInvoke.mock.calls.filter(
      (c) => c[0] === "set_failover_settings",
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0][1]).toEqual({ enabled: true, excludedIds: ["srv-1"] });
  });

  it("propagates an exclusion-set change to a second live instance (CR-01 still holds)", () => {
    const a = renderHook(() => useAppSettings());
    const b = renderHook(() => useAppSettings());

    act(() => {
      a.result.current.setFailoverExcludedIds(["srv-1"]);
    });

    expect(b.result.current.settings.failoverExcludedIds).toEqual(["srv-1"]);
  });
});
