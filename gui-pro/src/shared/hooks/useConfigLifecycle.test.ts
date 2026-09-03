import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useConfigLifecycle } from "./useConfigLifecycle";
import { captureListeners } from "../../test/fixtures/events";
import { markSelfDelete, clearSelfDelete } from "../utils/selfDeleteGuard";
import type { AppTab, VpnConfig, VpnStatus } from "../types";
import type { i18n as I18nType } from "i18next";

// `@tauri-apps/api/event` listen + `@tauri-apps/api/core` invoke are globally
// mocked in src/test/tauri-mock.ts. captureListeners re-points listen at an
// in-memory registry so we can drive the `config-file-changed` event; the invoke
// mock is set per-test to drive read_client_config / auto_detect_config / the
// watch_config_file + unwatch_config_file calls.
//
// Characterization suite (Feathers-style): these tests pin the CURRENT behavior
// of the 119-LOC config-lifecycle hook (H-2 — it previously had ZERO tests) so
// the Wave-1/Wave-3 behavioral fixes downstream have a green foundation and any
// future regression in the delete / restore / startup-validation branches fails
// loudly. Assertions are on the invoked Tauri commands and the hook's setter
// callbacks — never on DOM/CSS (there is no DOM in a hook).

/**
 * Build the full param object the hook requires. All setters are vi.fn() so the
 * test can assert which lifecycle branch fired. `config.configPath` drives the
 * watch effect and the event-payload path-match branches.
 */
function makeParams(overrides: { configPath?: string; status?: VpnStatus; isSwitching?: boolean } = {}) {
  const config: VpnConfig = { configPath: overrides.configPath ?? "", logLevel: "info" };
  const setConfig = vi.fn();
  const setVpnMode = vi.fn();
  const setWizardKey = vi.fn();
  const setConnectionKey = vi.fn();
  const setActiveTab = vi.fn();
  const pushSuccess = vi.fn();
  const onDisconnect = vi.fn();
  // The hook only calls i18n.t(); a thin stub returning the fallback is enough.
  const i18n = { t: (_key: string, fallback?: string) => fallback ?? _key } as unknown as I18nType;

  return {
    params: {
      config,
      setConfig,
      setVpnMode,
      setWizardKey,
      setConnectionKey,
      activeTab: "control" as AppTab,
      setActiveTab,
      pushSuccess,
      i18n,
      // IN-32: default to disconnected so existing branches keep their original behavior; the
      // IN-32 tests pass status: "connected" to exercise the external-delete disconnect.
      status: overrides.status ?? ("disconnected" as VpnStatus),
      onDisconnect,
      // FAB-05: default false; the switch-in-flight test sets it true to assert the delete is deferred.
      isSwitching: overrides.isSwitching ?? false,
    },
    setters: { setConfig, setVpnMode, setWizardKey, setConnectionKey, setActiveTab, pushSuccess, onDisconnect },
  };
}

describe("useConfigLifecycle (H-2 characterization)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Default invoke: resolve everything to a benign empty value so unrelated
    // lifecycle calls (watch/unwatch) do not reject.
    vi.mocked(invoke).mockResolvedValue(null as never);
  });

  // ── Startup validation: a saved path that still reads OK ───────────────────
  it("startup validation ACCEPT: a valid saved path reads the config and applies vpn_mode", async () => {
    localStorage.setItem("tt_config_path", "C:/cfg/client.toml");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return { vpn_mode: "split" } as never;
      return null as never;
    });
    const { params, setters } = makeParams();
    captureListeners();

    renderHook(() => useConfigLifecycle(params));
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("read_client_config", { configPath: "C:/cfg/client.toml" });
    expect(setters.setVpnMode).toHaveBeenCalledWith("split");
    // Saved path is NOT cleared on the accept branch.
    expect(localStorage.getItem("tt_config_path")).toBe("C:/cfg/client.toml");
    expect(setters.setConfig).not.toHaveBeenCalled();
  });

  // ── Startup validation: a saved path that no longer reads (reject branch) ──
  it("startup validation REJECT: an unreadable saved path clears localStorage + resets config", async () => {
    localStorage.setItem("tt_config_path", "C:/gone/client.toml");
    localStorage.setItem("tt_active_tab", "connection");
    localStorage.setItem("trusttunnel_wizard", "{}");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") throw "config file not found";
      return null as never;
    });
    const { params, setters } = makeParams();
    captureListeners();

    renderHook(() => useConfigLifecycle(params));
    await act(async () => {
      await Promise.resolve();
    });

    // The catch path purges the stale localStorage keys and resets config + wizard.
    expect(localStorage.getItem("tt_config_path")).toBeNull();
    expect(localStorage.getItem("tt_active_tab")).toBeNull();
    expect(localStorage.getItem("trusttunnel_wizard")).toBeNull();
    expect(setters.setConfig).toHaveBeenCalledWith({ configPath: "", logLevel: "info" });
    expect(setters.setWizardKey).toHaveBeenCalled();
  });

  // ── Startup with no saved path: auto-detect runs and navigates ────────────
  it("no saved path: auto_detect_config runs, applies the detected path, navigates off control", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "auto_detect_config") return "C:/auto/detected.toml" as never;
      return null as never;
    });
    const { params, setters } = makeParams();
    captureListeners();

    renderHook(() => useConfigLifecycle(params));
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("auto_detect_config");
    // setConfig is called with an updater fn; invoke it to inspect the result.
    const updater = setters.setConfig.mock.calls[0][0] as (prev: VpnConfig) => VpnConfig;
    expect(updater({ configPath: "", logLevel: "info" })).toEqual({
      configPath: "C:/auto/detected.toml",
      logLevel: "info",
    });
    // activeTab was "control" → auto-detect navigates to "connection".
    expect(setters.setActiveTab).toHaveBeenCalledWith("connection");
  });

  // ── No saved path + user explicitly cleared config: auto-detect is skipped ─
  it("no saved path but tt_config_cleared set: auto_detect_config is NOT called", async () => {
    localStorage.setItem("tt_config_cleared", "1");
    const { params, setters } = makeParams();
    captureListeners();

    renderHook(() => useConfigLifecycle(params));
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).not.toHaveBeenCalledWith("auto_detect_config");
    expect(setters.setConfig).not.toHaveBeenCalled();
  });

  // ── Watch effect: a set configPath registers the watcher ──────────────────
  it("watch effect: a non-empty configPath invokes watch_config_file", async () => {
    const { params } = makeParams({ configPath: "C:/cfg/client.toml" });
    captureListeners();

    renderHook(() => useConfigLifecycle(params));

    expect(invoke).toHaveBeenCalledWith("watch_config_file", { configPath: "C:/cfg/client.toml" });
  });

  it("watch effect: unmount calls unwatch_config_file (cleanup)", async () => {
    const { params } = makeParams({ configPath: "C:/cfg/client.toml" });
    captureListeners();

    const { unmount } = renderHook(() => useConfigLifecycle(params));
    unmount();

    expect(invoke).toHaveBeenCalledWith("unwatch_config_file");
  });

  // ── config-file-changed: external DELETE of the watched file ──────────────
  it("DELETE path: a config-file-changed(exists=false) for the current path resets config + warns", async () => {
    localStorage.setItem("tt_config_path", "C:/cfg/client.toml");
    const { params, setters } = makeParams({ configPath: "C:/cfg/client.toml" });
    const events = captureListeners();

    renderHook(() => useConfigLifecycle(params));
    expect(events.count("config-file-changed")).toBe(1);

    await act(async () => {
      events.emitEvent("config-file-changed", { exists: false, path: "C:/cfg/client.toml" });
    });

    expect(localStorage.getItem("tt_config_path")).toBeNull();
    expect(setters.setConfig).toHaveBeenCalledWith({ configPath: "", logLevel: "info" });
    expect(setters.setWizardKey).toHaveBeenCalled();
    // Deletion surfaces an error-variant snackbar.
    expect(setters.pushSuccess).toHaveBeenCalledWith(expect.any(String), "error");
  });

  // ── B2 (16-UAT round 2) + #8 (Fable re-review): an APP-initiated delete of the active config
  //    must NOT fire the RED external-delete warning (the panel already showed the green success)
  //    NOR issue a redundant disconnect (the panel disconnected via D-03) — but it MUST STILL run
  //    the active-pointer cleanup. Pre-#8 the guard blanket-returned, leaving config.configPath +
  //    tt_config_path dangling at the deleted .toml (StatusPanel rendered a gone config; the next
  //    import was not auto-activated). Now the pointer is reconciled on a self-delete too. ──
  it("B2/#8: an app-initiated delete of the active config CLEARS the active pointer but fires NO red snackbar and NO disconnect", async () => {
    localStorage.setItem("tt_config_path", "C:/cfg/client.toml");
    // status connected so we can assert the disconnect is NOT re-fired here (the panel owns D-03).
    const { params, setters } = makeParams({ configPath: "C:/cfg/client.toml", status: "connected" });
    const events = captureListeners();

    renderHook(() => useConfigLifecycle(params));

    // The in-app delete marks the path around invoke("delete_config"); the fs-watcher Remove then
    // arrives as config-file-changed{exists:false} for the SAME (active) file.
    markSelfDelete("C:/cfg/client.toml");
    try {
      await act(async () => {
        events.emitEvent("config-file-changed", { exists: false, path: "C:/cfg/client.toml" });
      });

      // Suppressed: no red snackbar (the panel's green success stands), no redundant disconnect.
      expect(setters.pushSuccess).not.toHaveBeenCalled();
      expect(setters.onDisconnect).not.toHaveBeenCalled();
      // #8: the active pointer IS reconciled — otherwise it would strand at the deleted .toml.
      expect(localStorage.getItem("tt_config_path")).toBeNull();
      expect(setters.setConfig).toHaveBeenCalledWith({ configPath: "", logLevel: "info" });
      expect(setters.setWizardKey).toHaveBeenCalled();
    } finally {
      clearSelfDelete("C:/cfg/client.toml");
    }
  });

  it("B2: a GENUINE external delete (path NOT marked) STILL fires the red warning", async () => {
    localStorage.setItem("tt_config_path", "C:/cfg/client.toml");
    const { params, setters } = makeParams({ configPath: "C:/cfg/client.toml", status: "disconnected" });
    const events = captureListeners();

    renderHook(() => useConfigLifecycle(params));

    // No markSelfDelete — the user deleted the .toml in Explorer.
    await act(async () => {
      events.emitEvent("config-file-changed", { exists: false, path: "C:/cfg/client.toml" });
    });

    // The external-delete warning must still fire (regression guard for the B2 fix).
    expect(setters.pushSuccess).toHaveBeenCalledWith(expect.any(String), "error");
    expect(setters.setConfig).toHaveBeenCalledWith({ configPath: "", logLevel: "info" });
  });

  // ── IN-32: external delete of the ACTIVE config while CONNECTED tears down the tunnel ──
  it("IN-32: deleting the active config while connected calls onDisconnect", async () => {
    localStorage.setItem("tt_config_path", "C:/cfg/client.toml");
    const { params, setters } = makeParams({ configPath: "C:/cfg/client.toml", status: "connected" });
    const events = captureListeners();

    renderHook(() => useConfigLifecycle(params));
    await act(async () => {
      events.emitEvent("config-file-changed", { exists: false, path: "C:/cfg/client.toml" });
    });

    expect(setters.onDisconnect).toHaveBeenCalled();
    // Still resets the config + warns (existing behavior preserved).
    expect(setters.setConfig).toHaveBeenCalledWith({ configPath: "", logLevel: "info" });
  });

  it("FAB-05: an external delete of the active config while a switch is in flight is DEFERRED (no ungated disconnect, no path wipe)", async () => {
    localStorage.setItem("tt_config_path", "C:/cfg/client.toml");
    // A seamless A→B switch is in flight AND the tunnel is live (connected transiently during the
    // swap). An fs-watcher delete event landing here must NOT tear down the tunnel (it would race the
    // swap) NOR wipe config.configPath (blanking it strands the swap + unmounts the frosted hero).
    const { params, setters } = makeParams({
      configPath: "C:/cfg/client.toml",
      status: "connected",
      isSwitching: true,
    });
    const events = captureListeners();

    renderHook(() => useConfigLifecycle(params));
    await act(async () => {
      events.emitEvent("config-file-changed", { exists: false, path: "C:/cfg/client.toml" });
    });

    // Deferred: no disconnect, no config wipe, no warning snackbar — the switch owns the lifecycle.
    expect(setters.onDisconnect).not.toHaveBeenCalled();
    expect(setters.setConfig).not.toHaveBeenCalled();
    expect(localStorage.getItem("tt_config_path")).toBe("C:/cfg/client.toml");
  });

  it("IN-32: deleting the active config while already disconnected does NOT call onDisconnect", async () => {
    localStorage.setItem("tt_config_path", "C:/cfg/client.toml");
    const { params, setters } = makeParams({ configPath: "C:/cfg/client.toml", status: "disconnected" });
    const events = captureListeners();

    renderHook(() => useConfigLifecycle(params));
    await act(async () => {
      events.emitEvent("config-file-changed", { exists: false, path: "C:/cfg/client.toml" });
    });

    expect(setters.onDisconnect).not.toHaveBeenCalled();
  });

  // ── config-file-changed: external RESTORE while no config loaded ──────────
  it("RESTORE path: a config-file-changed(exists=true) while no config loaded reloads silently (no nav)", async () => {
    // configPath empty → the restore branch (exists && !config.configPath) fires.
    const { params, setters } = makeParams({ configPath: "" });
    const events = captureListeners();

    renderHook(() => useConfigLifecycle(params));

    await act(async () => {
      events.emitEvent("config-file-changed", { exists: true, path: "C:/cfg/restored.toml" });
    });

    expect(setters.setConfig).toHaveBeenCalledWith({ configPath: "C:/cfg/restored.toml", logLevel: "info" });
    expect(localStorage.getItem("tt_config_path")).toBe("C:/cfg/restored.toml");
    expect(setters.setConnectionKey).toHaveBeenCalled();
    // Restore shows a success snackbar and must NOT yank the user to another tab.
    expect(setters.pushSuccess).toHaveBeenCalledWith(expect.any(String));
    expect(setters.setActiveTab).not.toHaveBeenCalled();
  });

  it("config-file-changed: unmount unsubscribes the listener (no leak)", async () => {
    const { params } = makeParams({ configPath: "C:/cfg/client.toml" });
    const events = captureListeners();

    const { unmount } = renderHook(() => useConfigLifecycle(params));
    expect(events.count("config-file-changed")).toBe(1);

    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(events.count("config-file-changed")).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The raw-path-comparison class (30.1 class sweep) — site 3 of 3, and the one
// the milestone review never named.
//
// This watcher compared `event.payload.path` to `config.configPath` with a byte
// `===`. The path the fs-watcher reports and the path the app stored are the SAME
// FILE routinely arriving in different string forms on Windows — `C:\…` vs `C:/…`,
// `c:` vs `C:`. On a mismatch the branch simply did not run, so an external delete
// of the ACTIVE config was not recognised: the active pointer was never cleared and
// the UI kept rendering — and offering «Подключить» on — a config that is gone.
//
// Its two siblings (useVpnActions.markLastUsed, useAutoConnect's last-used
// reconciliation) carry the same note; all three now compare through `samePath`.
// ─────────────────────────────────────────────────────────────────────────
describe("useConfigLifecycle — the raw-path-comparison class (30.1, site 3 of 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(invoke).mockResolvedValue(null as never);
  });

  it("recognises an external delete reported with backslashes and a differently-cased drive letter", async () => {
    localStorage.setItem("tt_config_path", "C:/cfg/client.toml");
    const { params, setters } = makeParams({ configPath: "C:/cfg/client.toml" });
    const events = captureListeners();

    renderHook(() => useConfigLifecycle(params));

    // The very same file, in Windows' own native spelling. A byte comparison calls this a
    // different file and silently does nothing.
    await act(async () => {
      events.emitEvent("config-file-changed", { exists: false, path: "c:\\cfg\\client.toml" });
    });

    // The active pointer is cleared on all three surfaces that hold it.
    expect(localStorage.getItem("tt_config_path")).toBeNull();
    expect(setters.setConfig).toHaveBeenCalledWith({ configPath: "", logLevel: "info" });
    expect(setters.setWizardKey).toHaveBeenCalled();
    // …and the user is told, because this one really was an external delete.
    expect(setters.pushSuccess).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("still leaves the active pointer alone when a DIFFERENT config is deleted", async () => {
    // The helper must not become so forgiving that any delete clears the pointer — normalizing
    // separators and case is the whole latitude it is allowed.
    localStorage.setItem("tt_config_path", "C:/cfg/client.toml");
    const { params, setters } = makeParams({ configPath: "C:/cfg/client.toml" });
    const events = captureListeners();

    renderHook(() => useConfigLifecycle(params));

    await act(async () => {
      events.emitEvent("config-file-changed", { exists: false, path: "C:\\cfg\\other.toml" });
    });

    expect(localStorage.getItem("tt_config_path")).toBe("C:/cfg/client.toml");
    expect(setters.setConfig).not.toHaveBeenCalled();
    expect(setters.pushSuccess).not.toHaveBeenCalled();
  });
});
