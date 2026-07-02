import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * App-level «Авто-режим» settings store (Phase 12, plan 12-03).
 *
 * One typed load-on-mount / save-on-change layer for the 6 app-global «Авто-режим»
 * preferences. Uses the existing localStorage idiom from `settings/GeneralSection.tsx`
 * (the `tt_auto_connect` block) — generalized to a typed group. NO new dependency
 * (RESEARCH §Standard Stack default path); these prefs are app-global, never per-config
 * `.toml`.
 *
 * Key map (Phase 13 reads `notificationsOn` from `tt_notifications_enabled`):
 *   masterOn            → tt_auto_switch_enabled
 *   thresholdMs         → tt_auto_switch_threshold_ms
 *   intervalSec         → tt_auto_switch_interval_sec
 *   checksN             → tt_auto_switch_checks
 *   autoConnectOnLaunch → tt_auto_connect      (A3: the EXISTING key — reused, NOT forked.
 *                          `useAutoConnect` + `GeneralSection` already read/write it.)
 *   notificationsOn     → tt_notifications_enabled
 *
 * V5 / T-12-05: numeric prefs are clamped to their locked bounds on BOTH read and write,
 * so a tampered/corrupt out-of-range value (e.g. interval=0) can never reach the ping
 * loop and cause a tight ping-storm. T-12-06: a non-numeric/corrupt stored value falls
 * back to the locked default (no throw, no NaN to the engine).
 */

export interface AppSettings {
  /** Master toggle: auto-switch to the best server (D-locked default OFF). */
  masterOn: boolean;
  /** Auto-switch ping threshold in ms (separate value from the 150/300 green/yellow/red bands). */
  thresholdMs: number;
  /** Active-config check interval in seconds. */
  intervalSec: number;
  /** Consecutive breaching checks before a switch fires (D-04). */
  checksN: number;
  /** Connect to the last-used config at startup (D-01); bound to the existing tt_auto_connect key. */
  autoConnectOnLaunch: boolean;
  /** Connection-state desktop notifications (D-06: persisted now, wired in Phase 13). */
  notificationsOn: boolean;
}

/** LOCKED defaults (D-04/D-06 + design contract). Exported so 12-05/12-06 import the SAME numbers. */
export const APP_SETTINGS_DEFAULTS: AppSettings = {
  masterOn: false,
  thresholdMs: 300,
  intervalSec: 15,
  checksN: 3,
  autoConnectOnLaunch: true,
  notificationsOn: true,
};

/** LOCKED clamp bounds (V5). Exported so the engine/UI use the SAME ranges (no drift). */
export const AUTO_SWITCH_BOUNDS = {
  thresholdMs: { min: 50, max: 5000 },
  intervalSec: { min: 5, max: 300 },
  checksN: { min: 1, max: 10 },
} as const;

/** localStorage key map. `autoConnectOnLaunch` deliberately reuses the existing key. */
export const APP_SETTINGS_KEYS = {
  masterOn: "tt_auto_switch_enabled",
  thresholdMs: "tt_auto_switch_threshold_ms",
  intervalSec: "tt_auto_switch_interval_sec",
  checksN: "tt_auto_switch_checks",
  autoConnectOnLaunch: "tt_auto_connect", // A3 — existing key, do NOT fork
  notificationsOn: "tt_notifications_enabled",
} as const;

/**
 * CR-01 (Phase 12 review): every `useAppSettings` instance must stay in sync within the SAME
 * document. App.tsx (which feeds the live `useAutoSwitch` engine) and AutoModeSettings (the
 * controls) each hold their OWN instance — without a sync channel, flipping the master toggle
 * (or tuning threshold/interval/checks) in Settings never reached the running engine until an
 * app restart, making the feature's primary control a no-op in-session.
 *
 * The fix keeps the lightweight localStorage design: on every write we persist to localStorage
 * AND dispatch a same-document `CustomEvent` (the native `storage` event does NOT fire in the
 * document that wrote it). Every instance subscribes to that event (and the cross-tab `storage`
 * event) and re-reads its state from localStorage. Net effect: a pref change in AutoModeSettings
 * immediately re-renders the App.tsx engine instance, so `useAutoSwitch` starts/stops/retunes.
 */
const APP_SETTINGS_CHANGED_EVENT = "tt-app-settings-changed";

function broadcastSettingsChanged(): void {
  // Guard for non-DOM environments (defensive — these hooks only run in the browser/Tauri webview).
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(APP_SETTINGS_CHANGED_EVENT));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Read the full settings group from localStorage (clamped/defaulted per V5/T-12-06). */
function readAppSettings(): AppSettings {
  return {
    masterOn: readBoolean(
      APP_SETTINGS_KEYS.masterOn,
      APP_SETTINGS_DEFAULTS.masterOn,
    ),
    thresholdMs: readNumber(
      APP_SETTINGS_KEYS.thresholdMs,
      APP_SETTINGS_DEFAULTS.thresholdMs,
      AUTO_SWITCH_BOUNDS.thresholdMs,
    ),
    intervalSec: readNumber(
      APP_SETTINGS_KEYS.intervalSec,
      APP_SETTINGS_DEFAULTS.intervalSec,
      AUTO_SWITCH_BOUNDS.intervalSec,
    ),
    checksN: readNumber(
      APP_SETTINGS_KEYS.checksN,
      APP_SETTINGS_DEFAULTS.checksN,
      AUTO_SWITCH_BOUNDS.checksN,
    ),
    autoConnectOnLaunch: readBoolean(
      APP_SETTINGS_KEYS.autoConnectOnLaunch,
      APP_SETTINGS_DEFAULTS.autoConnectOnLaunch,
    ),
    notificationsOn: readBoolean(
      APP_SETTINGS_KEYS.notificationsOn,
      APP_SETTINGS_DEFAULTS.notificationsOn,
    ),
  };
}

/**
 * Read a numeric pref: clamp to bounds when valid, fall back to the default when the
 * stored value is absent or non-numeric. The fallback default is itself in-range, so
 * the consumer never sees NaN or an out-of-range number.
 */
function readNumber(
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = localStorage.getItem(key);
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, bounds.min, bounds.max);
}

function readBoolean(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "true";
}

export interface UseAppSettings {
  settings: AppSettings;
  setMasterOn: (value: boolean) => void;
  setThresholdMs: (value: number) => void;
  setIntervalSec: (value: number) => void;
  setChecksN: (value: number) => void;
  setAutoConnectOnLaunch: (value: boolean) => void;
  setNotificationsOn: (value: boolean) => void;
}

export function useAppSettings(): UseAppSettings {
  // Lazy initializer reads localStorage once on mount — exactly the GeneralSection idiom,
  // generalized to the typed group (and clamped per V5).
  const [settings, setSettings] = useState<AppSettings>(readAppSettings);

  // CR-01: every instance re-reads from localStorage whenever ANY instance writes (same-document
  // CustomEvent) or another tab writes (native `storage` event). This is what keeps the App.tsx
  // engine instance and the AutoModeSettings controls instance in lockstep within one session.
  const syncFromStorage = useCallback(() => {
    setSettings(readAppSettings());
  }, []);

  useEffect(() => {
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, syncFromStorage);
    // The native `storage` event fires only in OTHER documents/tabs — harmless here (single window),
    // but kept so a second window (e.g. a future detached log window) would stay consistent too.
    window.addEventListener("storage", syncFromStorage);
    return () => {
      window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, syncFromStorage);
      window.removeEventListener("storage", syncFromStorage);
    };
  }, [syncFromStorage]);

  // Phase 13 (D-06 / §C): mirror the PERSISTED master-toggle value into the Rust gate ONCE at
  // startup, so `notify::maybe_fire` gates correctly BEFORE the first in-session toggle (the Rust
  // pre-seed default is `true` — this reconciles it to the user's saved preference). Read from
  // localStorage (the source of truth) rather than the reactive `settings` so this fires exactly
  // once on mount and does not re-push on every settings change (the change-path push in
  // `setNotificationsOn` covers those). Fire-and-forget; a bare bool only (no secret — D-29).
  useEffect(() => {
    const persisted = readBoolean(
      APP_SETTINGS_KEYS.notificationsOn,
      APP_SETTINGS_DEFAULTS.notificationsOn,
    );
    void invoke("set_notifications_enabled", { enabled: persisted });
  }, []);

  function persistBoolean(key: string, value: boolean): void {
    localStorage.setItem(key, String(value));
  }

  function persistNumber(
    key: string,
    value: number,
    bounds: { min: number; max: number },
  ): number {
    // Clamp on write too (V5) — the UI NumberInput already bounds input, but a programmatic
    // setter must never persist an out-of-range value the next reader would have to fix.
    const clamped = clamp(value, bounds.min, bounds.max);
    localStorage.setItem(key, String(clamped));
    return clamped;
  }

  const setMasterOn = (value: boolean) => {
    persistBoolean(APP_SETTINGS_KEYS.masterOn, value);
    setSettings((s) => ({ ...s, masterOn: value }));
    broadcastSettingsChanged();
  };

  const setThresholdMs = (value: number) => {
    const clamped = persistNumber(
      APP_SETTINGS_KEYS.thresholdMs,
      value,
      AUTO_SWITCH_BOUNDS.thresholdMs,
    );
    setSettings((s) => ({ ...s, thresholdMs: clamped }));
    broadcastSettingsChanged();
  };

  const setIntervalSec = (value: number) => {
    const clamped = persistNumber(
      APP_SETTINGS_KEYS.intervalSec,
      value,
      AUTO_SWITCH_BOUNDS.intervalSec,
    );
    setSettings((s) => ({ ...s, intervalSec: clamped }));
    broadcastSettingsChanged();
  };

  const setChecksN = (value: number) => {
    const clamped = persistNumber(
      APP_SETTINGS_KEYS.checksN,
      value,
      AUTO_SWITCH_BOUNDS.checksN,
    );
    setSettings((s) => ({ ...s, checksN: clamped }));
    broadcastSettingsChanged();
  };

  const setAutoConnectOnLaunch = (value: boolean) => {
    // Writes the EXISTING tt_auto_connect key so useAutoConnect keeps working (A3).
    persistBoolean(APP_SETTINGS_KEYS.autoConnectOnLaunch, value);
    setSettings((s) => ({ ...s, autoConnectOnLaunch: value }));
    broadcastSettingsChanged();
  };

  const setNotificationsOn = (value: boolean) => {
    persistBoolean(APP_SETTINGS_KEYS.notificationsOn, value);
    setSettings((s) => ({ ...s, notificationsOn: value }));
    broadcastSettingsChanged();
    // Phase 13 (D-06 / §C): mirror the master toggle into the Rust gate
    // (`AppState.notifications_enabled`) so `notify::maybe_fire` gates the plate even with the
    // main window closed to tray — localStorage is NOT shared across webview windows (Pitfall 5),
    // so the gate MUST live in Rust, not localStorage. Fire-and-forget (`void`): the toggle write
    // is already persisted; a failed mirror push (e.g. no backend in a test) must not throw in a
    // UI event handler. The payload is a bare bool — never config content or a password (D-29).
    void invoke("set_notifications_enabled", { enabled: value });
  };

  return {
    settings,
    setMasterOn,
    setThresholdMs,
    setIntervalSec,
    setChecksN,
    setAutoConnectOnLaunch,
    setNotificationsOn,
  };
}
