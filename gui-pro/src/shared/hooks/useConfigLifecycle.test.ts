import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useConfigLifecycle } from "./useConfigLifecycle";
import { captureListeners } from "../../test/fixtures/events";
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
function makeParams(overrides: { configPath?: string; status?: VpnStatus } = {}) {
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
