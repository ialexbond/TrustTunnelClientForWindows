import { useState, useEffect, useCallback, useRef } from "react";
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
 *   autoConnectOnLaunch → tt_auto_connect      (A3: the EXISTING key — reused, NOT forked.
 *                          `useAutoConnect` + `GeneralSection` already read/write it.)
 *   notificationsOn     → tt_notifications_enabled
 *   failoverExcludedIds → tt_auto_switch_excluded_ids
 *
 * PHASE 28 / 27 D-07 — THREE PREFERENCES REMOVED. `thresholdMs`, `intervalSec` and `checksN` used
 * to live here, clamped on read and on write (V5 / T-12-05) against an `AUTO_SWITCH_BOUNDS` table.
 * All of it is gone, and so is the table: those three numbers only ever tuned the FRONTEND LATENCY
 * ENGINE that this phase retires. Failover now fires on a real loss of the tunnel, decided in Rust —
 * there is no polling interval to set, no latency threshold to cross and no breach count to reach,
 * so a knob for any of them would configure nothing.
 *
 * The values already on disk are ABANDONED, NOT PURGED (28-CONTEXT OQ-3). Nothing reads
 * `tt_auto_switch_threshold_ms`, `tt_auto_switch_interval_sec` or `tt_auto_switch_checks` any more,
 * which makes them inert; writing a migration to delete three dead entries would add a step that can
 * fail loudly on somebody's machine in exchange for nothing the user can see. Do not add one later
 * either — a delete-on-launch pass over abandoned keys is a hazard with no upside.
 */

export interface AppSettings {
  /**
   * Master toggle. 27 D-06/D-07: this is now the FAILOVER master — «переключаться на другой сервер
   * при потере связи» — and NOT the retired «auto-connect to the best server». The stored key is
   * deliberately unchanged (see `APP_SETTINGS_KEYS`), so an existing preference carries over.
   */
  masterOn: boolean;
  /** Connect to the last-used config at startup (D-01); bound to the existing tt_auto_connect key. */
  autoConnectOnLaunch: boolean;
  /** Connection-state desktop notifications (D-06: persisted now, wired in Phase 13). */
  notificationsOn: boolean;
  /**
   * Phase 28 / 27 D-08: config ids (`ConfigEntry.id`) the user has opted OUT of the failover
   * queue. An EXCLUSION set, not an inclusion set, so a newly added server participates by
   * default instead of sitting silently outside the queue until the user finds the switch.
   */
  failoverExcludedIds: string[];
}

/** LOCKED defaults (D-04/D-06 + design contract). Exported so 12-05/12-06 import the SAME numbers. */
export const APP_SETTINGS_DEFAULTS: AppSettings = {
  masterOn: false,
  autoConnectOnLaunch: true,
  notificationsOn: true,
  failoverExcludedIds: [],
};

// `AUTO_SWITCH_BOUNDS` used to sit here — the clamp table for the three removed numeric prefs. It is
// deleted outright rather than left as an empty object: a bounds table with nothing to bound is a
// monument to a feature, and the next reader would waste a search working out what it clamps.

/** localStorage key map. `autoConnectOnLaunch` deliberately reuses the existing key. */
export const APP_SETTINGS_KEYS = {
  masterOn: "tt_auto_switch_enabled",
  autoConnectOnLaunch: "tt_auto_connect", // A3 — existing key, do NOT fork
  notificationsOn: "tt_notifications_enabled",
  // Phase 28. `masterOn`'s key is deliberately unchanged: `tt_auto_switch_enabled` BECOMES the
  // failover master, so a user who had auto-switch on keeps failover on with no migration step.
  failoverExcludedIds: "tt_auto_switch_excluded_ids",
} as const;

/**
 * CR-01 (Phase 12 review): every `useAppSettings` instance must stay in sync within the SAME
 * document. Several surfaces hold their OWN instance — the Settings sections that render the
 * controls, and any consumer that reads a setting to decide what to show. Without a sync channel a
 * write from one instance was invisible to the others until an app restart, which made a toggle
 * look like a no-op in-session.
 *
 * The fix keeps the lightweight localStorage design: on every write we persist to localStorage
 * AND dispatch a same-document `CustomEvent` (the native `storage` event does NOT fire in the
 * document that wrote it). Every instance subscribes to that event (and the cross-tab `storage`
 * event) and re-reads its state from localStorage. Net effect: a write in one section re-renders
 * every other instance in the same document with the new value.
 *
 * Plan 28-09 note: the failover master toggle no longer has an in-document consumer to re-render —
 * the actor that obeys it lives in Rust and reads `app_settings.json` (see `persistFailoverSettings`
 * below), not this store. The broadcast still matters for every OTHER setting and for keeping two
 * open Settings surfaces agreeing, so it stays.
 */
const APP_SETTINGS_CHANGED_EVENT = "tt-app-settings-changed";

function broadcastSettingsChanged(): void {
  // Guard for non-DOM environments (defensive — these hooks only run in the browser/Tauri webview).
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(APP_SETTINGS_CHANGED_EVENT));
}

/**
 * Phase 28 / 27 D-06: push the failover pair into the Rust-readable store (`app_settings.json`).
 *
 * Why this exists at all: the failover monitor lives in the Rust connectivity path and runs with NO
 * window open — possibly before any webview has mounted this session — so it cannot read
 * localStorage, which stays the UI-facing store. Every write to either failover field has to come
 * through here or the monitor silently obeys a stale preference, and that failure reads to a user
 * as «оно просто не переключается».
 *
 * Both fields go together because the Rust writer replaces the pair; see the callers for why each
 * one re-reads the OTHER field from localStorage instead of the render closure.
 *
 * Module-level rather than defined inside the hook so the mount-seed effect can depend on it
 * without a per-render identity (exhaustive-deps).
 *
 * The payload is a bool plus a list of `ConfigEntry.id`s — non-secret identifiers that already
 * cross this boundary via the config commands. Never a password or config content (D-29).
 */
function mirrorFailoverToRust(
  enabled: boolean,
  excludedIds: string[],
  onFailure?: () => void,
): void {
  void invoke("set_failover_settings", { enabled, excludedIds }).catch(() => {
    // WR-02 (Phase-28 review). This used to be swallowed outright, on the reasoning that the
    // failure is self-healing: the next successful write re-syncs Rust and the mount seed re-syncs
    // it at the next launch. Both are true, and both are the WRONG timescale. Until one of them
    // happens the master toggle reads ON while `app_settings.json` reads OFF, so the failover
    // monitor never fires and NOTHING on screen says why — for the rest of the session. That is
    // the «оно просто не переключается» failure this very function's doc-comment says it exists to
    // prevent, and the user cannot even know to retry.
    //
    // The write is still NOT rolled back here: the localStorage value is already committed and the
    // caller owns what to do about it (the master toggle reverts the switch, the exclusion setter
    // only reports). This callback is the seam that lets them; the sentence rendered is the
    // caller's localized one, so no backend string reaches the screen (T-28-20 / D-29).
    onFailure?.();
  });
}

/** Read the full settings group from localStorage (defaulted per T-12-06). */
function readAppSettings(): AppSettings {
  return {
    masterOn: readBoolean(
      APP_SETTINGS_KEYS.masterOn,
      APP_SETTINGS_DEFAULTS.masterOn,
    ),
    autoConnectOnLaunch: readBoolean(
      APP_SETTINGS_KEYS.autoConnectOnLaunch,
      APP_SETTINGS_DEFAULTS.autoConnectOnLaunch,
    ),
    notificationsOn: readBoolean(
      APP_SETTINGS_KEYS.notificationsOn,
      APP_SETTINGS_DEFAULTS.notificationsOn,
    ),
    failoverExcludedIds: readStringArray(
      APP_SETTINGS_KEYS.failoverExcludedIds,
    ),
  };
}

/**
 * Read a JSON string array, falling back to `[]` on absent / unparseable / not-an-array —
 * the same defensive posture `readNumber` already takes for a corrupt numeric value (T-12-06).
 *
 * This runs inside `useState`'s lazy initializer, so a throw here would take the whole Settings
 * tab down on mount. Non-string members are dropped rather than rejecting the array wholesale:
 * a partially-corrupt file should cost the user the bad entries, not their whole opt-out set.
 */
function readStringArray(key: string): string[] {
  const raw = localStorage.getItem(key);
  if (raw === null || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

// `readNumber` and its `clamp` helper went with the three numeric prefs (27 D-07). Nothing in this
// store holds a number any more, so the reader had no caller left.

function readBoolean(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "true";
}

export interface UseAppSettings {
  settings: AppSettings;
  /**
   * WR-02: `onFailure` fires when the Rust mirror (`set_failover_settings`) refused. Only the two
   * FAILOVER setters carry it — they are the only writes whose refusal leaves a feature dead with
   * nothing on screen. Optional, so every existing caller is unchanged.
   */
  setMasterOn: (value: boolean, onFailure?: () => void) => void;
  setAutoConnectOnLaunch: (value: boolean) => void;
  setNotificationsOn: (value: boolean) => void;
  /**
   * Phase 28 / 27 D-08. Replaces the whole opt-out set.
   *
   * WR-11: accepts an UPDATER as well as a plain list, and the updater is the form callers should
   * reach for. A plain list has to be computed from somewhere, and the only «somewhere» a React
   * event handler has is its own render closure — so two participation toggles dispatched in ONE
   * batch (rapid clicks, or Space held across two rows) both derived their list from the same
   * pre-batch array and the second write silently dropped the first. The server the user opted out
   * of stayed in the real failover queue while the switch showed it excluded. The updater is handed
   * the set read from localStorage AT CALL TIME, which is the same re-read `setMasterOn` already
   * does for the other half of the pair.
   */
  setFailoverExcludedIds: (
    value: string[] | ((current: string[]) => string[]),
    onFailure?: () => void,
  ) => void;
  /**
   * WR-02: pull the failover pair back onto whatever Rust actually holds, for use after a refused
   * write. Reconciles TO Rust and never pushes back, so it cannot loop against a persistent
   * failure. A failed re-read leaves the stored value alone.
   */
  reconcileFailoverFromRust: () => Promise<void>;
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

  // Phase 28 (27 D-06): seed the Rust-readable failover copy ONCE from the values just read.
  //
  // Without this, an install upgrading from a build that never wrote `app_settings.json` sits on
  // the Rust-side default (failover OFF, nothing excluded) while the UI faithfully shows the ON the
  // user saved months ago — the monitor would simply never fire and nothing on screen would say why.
  // Reads localStorage rather than the reactive `settings` so this is a one-shot reconciliation and
  // not a re-push on every settings change (the setters below cover those).
  const failoverSeeded = useRef(false);
  useEffect(() => {
    // React 19 StrictMode mounts effects twice in dev; the ref makes the seed idempotent so the
    // "exactly one startup push" property holds there too.
    if (failoverSeeded.current) return;
    failoverSeeded.current = true;
    mirrorFailoverToRust(
      readBoolean(APP_SETTINGS_KEYS.masterOn, APP_SETTINGS_DEFAULTS.masterOn),
      readStringArray(APP_SETTINGS_KEYS.failoverExcludedIds),
    );
  }, []);

  function persistBoolean(key: string, value: boolean): void {
    localStorage.setItem(key, String(value));
  }

  // WR-02: both failover setters take an optional `onFailure`. `set_failover_settings` is the one
  // backend call the whole feature depends on, so a refusal has to reach the user; the section
  // decides HOW (the master toggle reverts, the exclusion set only reports). The two remaining
  // setters need no such seam — they write localStorage and, for notifications, a Rust gate that
  // is re-seeded at mount and cannot leave the feature dead.
  const setMasterOn = (value: boolean, onFailure?: () => void) => {
    persistBoolean(APP_SETTINGS_KEYS.masterOn, value);
    setSettings((s) => ({ ...s, masterOn: value }));
    broadcastSettingsChanged();
    // Phase 28: the Rust writer replaces BOTH failover fields, so the other half has to travel with
    // this one — a push carrying a stale exclusion set would quietly re-enrol servers the user had
    // opted out of. Read it from localStorage, not from the `settings` closure: this setter is not
    // memoized on `settings`, so the closure can be a render behind after a rapid double change.
    mirrorFailoverToRust(
      value,
      readStringArray(APP_SETTINGS_KEYS.failoverExcludedIds),
      onFailure,
    );
  };

  const setFailoverExcludedIds = (
    value: string[] | ((current: string[]) => string[]),
    onFailure?: () => void,
  ) => {
    // WR-11: resolve an updater against the set READ AT CALL TIME, never against the caller's
    // render closure. This setter is not memoized on `settings`, so a caller's closure is a render
    // behind after a rapid double change — and two participation toggles in one React batch are
    // exactly that. Both derived their «next» from the same pre-batch array and the second write
    // won, leaving a server the user had opted out of still in the failover queue with the UI
    // showing it excluded. The sibling `setMasterOn` already re-reads the OTHER half of the pair
    // here for the very same reason; this is that care applied to this half too.
    const next =
      typeof value === "function"
        ? value(readStringArray(APP_SETTINGS_KEYS.failoverExcludedIds))
        : value;
    // Stored as JSON so the reader can tell an empty set from an absent key; `readStringArray`
    // is the matching defensive reader.
    localStorage.setItem(
      APP_SETTINGS_KEYS.failoverExcludedIds,
      JSON.stringify(next),
    );
    setSettings((s) => ({ ...s, failoverExcludedIds: next }));
    broadcastSettingsChanged();
    // Symmetric to `setMasterOn`: carry the current master value so opting one server out cannot
    // switch failover off as a side effect.
    mirrorFailoverToRust(
      readBoolean(APP_SETTINGS_KEYS.masterOn, APP_SETTINGS_DEFAULTS.masterOn),
      next,
      onFailure,
    );
  };

  /**
   * WR-02: put the failover pair BACK on whatever Rust actually holds, after a refused write.
   *
   * The `revertTo()` shape 28-07 established in `GeneralSection`: re-read the value the APP
   * reports rather than inverting locally, because after a failure «the write was the only thing
   * that could have changed it» is exactly the assumption in doubt. Deliberately does NOT mirror
   * back to Rust — it is reconciling TO Rust, and a push here could refuse again and revert again,
   * forever. If even the re-read fails there is nothing to ask, so the stored value is left where
   * it is; the mount seed reconciles it at the next launch and the snackbar has already told the
   * user the setting did not take.
   */
  const reconcileFailoverFromRust = async () => {
    try {
      const actual = await invoke<{ enabled: boolean; excluded_ids: string[] }>(
        "get_failover_settings",
      );
      persistBoolean(APP_SETTINGS_KEYS.masterOn, actual.enabled);
      localStorage.setItem(
        APP_SETTINGS_KEYS.failoverExcludedIds,
        JSON.stringify(actual.excluded_ids ?? []),
      );
      setSettings((s) => ({
        ...s,
        masterOn: actual.enabled,
        failoverExcludedIds: actual.excluded_ids ?? [],
      }));
      broadcastSettingsChanged();
    } catch {
      // Nothing to reconcile against — leave the stored value alone (see above).
    }
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
    setAutoConnectOnLaunch,
    setNotificationsOn,
    setFailoverExcludedIds,
    reconcileFailoverFromRust,
  };
}
