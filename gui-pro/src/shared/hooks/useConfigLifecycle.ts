import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { i18n as I18nType } from "i18next";
import type { AppTab, VpnConfig, VpnStatus } from "../types";

interface UseConfigLifecycleParams {
  config: VpnConfig;
  setConfig: React.Dispatch<React.SetStateAction<VpnConfig>>;
  setVpnMode: React.Dispatch<React.SetStateAction<string>>;
  setWizardKey: React.Dispatch<React.SetStateAction<number>>;
  setConnectionKey: React.Dispatch<React.SetStateAction<number>>;
  activeTab: AppTab;
  setActiveTab: React.Dispatch<React.SetStateAction<AppTab>>;
  pushSuccess: (message: string, variant?: "success" | "error") => void;
  i18n: I18nType;
  /** IN-32: live VPN status — to decide whether an external delete of the active config must
   *  tear down a running tunnel. */
  status: VpnStatus;
  /** IN-32: the normal disconnect (vpn_disconnect). Called when the ACTIVE config file is
   *  deleted on disk while the tunnel is live.
   *  FAB-05: App now passes the SWITCH-GUARDED disconnect so an external delete mid-switch cannot
   *  fire an ungated teardown that races the swap. */
  onDisconnect: () => Promise<void> | void;
  /**
   * Phase 14 (FAB-05): true while a seamless A→B switch is in flight. When a switch is running the
   * active pointer is mid-transition to B; an fs-watcher external-delete event must NOT wipe
   * config.configPath (blanking it strands the swap + unmounts the hero) nor issue an ungated
   * disconnect. The delete-handling is DEFERRED — the switch settles on its own, and a genuinely-gone
   * file surfaces on the next watcher event / focus refresh once the swap is done. Optional so
   * standalone tests keep type-checking (absent = never switching, the pre-fix behaviour).
   */
  isSwitching?: boolean;
}

/**
 * Lifecycle hook for the VPN config file:
 * - On mount: validate saved path, auto-detect if empty, clean up stale localStorage.
 * - Watch file while a path is set; unwatch on change/unmount.
 * - React to `config-file-changed` events (external delete / restore).
 *
 * Extracted from App.tsx verbatim (Phase 12.5, D-03).
 */
export function useConfigLifecycle({
  config,
  setConfig,
  setVpnMode,
  setWizardKey,
  setConnectionKey,
  activeTab,
  setActiveTab,
  pushSuccess,
  i18n,
  status,
  onDisconnect,
  isSwitching = false,
}: UseConfigLifecycleParams) {
  // IN-32: keep the latest status + disconnect handler in refs so the config-file-changed
  // listener (which only re-subscribes on config.configPath) always reads the CURRENT values
  // without re-subscribing on every status tick.
  // FAB-05: isSwitching is mirrored the same way so the external-delete branch can defer while a
  // switch is in flight without re-subscribing the listener on every flag flip.
  const statusRef = useRef(status);
  const onDisconnectRef = useRef(onDisconnect);
  const isSwitchingRef = useRef(isSwitching);
  useEffect(() => {
    statusRef.current = status;
    onDisconnectRef.current = onDisconnect;
    isSwitchingRef.current = isSwitching;
  });
  // ─── Config validation on startup ───
  // WR-05 fix: explicit startup-once guard via useRef. Without this the
  // effect would re-run in React.StrictMode (DEV), double-clearing the
  // wizard localStorage entries and issuing two auto_detect_config calls.
  const didValidateStartupRef = useRef(false);
  useEffect(() => {
    if (didValidateStartupRef.current) return;
    didValidateStartupRef.current = true;
    const savedPath = localStorage.getItem("tt_config_path");
    if (savedPath) {
      invoke<{ vpn_mode?: string }>("read_client_config", { configPath: savedPath })
        .then((cfg) => {
          if (cfg?.vpn_mode) setVpnMode(cfg.vpn_mode);
        })
        .catch(() => {
          localStorage.removeItem("tt_config_path");
          localStorage.removeItem("tt_active_page");
          localStorage.removeItem("tt_active_tab");
          localStorage.removeItem("tt_connected_since");
          localStorage.removeItem("trusttunnel_wizard");
          setConfig({ configPath: "", logLevel: "info" });
          setWizardKey((k) => k + 1);
        });
    } else {
      localStorage.removeItem("trusttunnel_wizard");
      localStorage.removeItem("tt_active_page");
      localStorage.removeItem("tt_active_tab");
      localStorage.removeItem("tt_connected_since");

      // Skip auto-detect if user explicitly cleared config
      const wasCleared = localStorage.getItem("tt_config_cleared");
      if (!wasCleared) {
        invoke<string | null>("auto_detect_config")
          .then((detected) => {
            if (detected) {
              setConfig((prev) => ({ ...prev, configPath: detected }));
              if (activeTab === "control") setActiveTab("connection");
            }
          })
          .catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Watch config file for external deletion ───
  useEffect(() => {
    if (config.configPath) {
      invoke("watch_config_file", { configPath: config.configPath }).catch(() => {});
    }
    return () => {
      invoke("unwatch_config_file").catch(() => {});
    };
  }, [config.configPath]);

  useEffect(() => {
    const unlisten = listen<{ exists: boolean; path: string }>("config-file-changed", (event) => {
      const { exists, path } = event.payload;
      if (!exists && path === config.configPath) {
        // Config file was deleted externally.
        // Phase 14 (FAB-05): DEFER the whole delete-handling while a seamless A→B switch is in flight.
        // During a switch config.configPath is mid-transition to B; an fs-watcher event here (e.g. the
        // teardown briefly touches the file, or a real delete lands in the swap window) must NOT wipe
        // the path (blanking it strands the swap + unmounts the frosted hero) nor fire an ungated
        // disconnect that races the swap. The switch is self-terminating; a genuinely-gone file
        // resurfaces on the next watcher event / focus refresh once the swap has settled.
        if (isSwitchingRef.current) return;
        // IN-32: if the deleted file is the ACTIVE config and a tunnel is live, tear it down
        // FIRST — the sidecar is still running on a now-gone file. Reuse the switch-GUARDED disconnect
        // (FAB-05 — App passes handleDisconnectGuarded; never touch the killswitch/sidecar internals).
        // Read the live values from refs.
        if (statusRef.current !== "disconnected" && statusRef.current !== "error") {
          void onDisconnectRef.current();
        }
        localStorage.removeItem("tt_config_path");
        setConfig({ configPath: "", logLevel: "info" });
        setWizardKey((k) => k + 1);
        pushSuccess(i18n.t("messages.config_file_deleted", "Config file was deleted"), "error");
      } else if (exists && !config.configPath) {
        // Config file appeared — reload it. 06-uat: do NOT auto-navigate to the
        // Connection tab here. An externally-restored config file should not yank the
        // user away from whatever section they are on; the config is loaded silently and
        // the snackbar tells them. (The first-load auto-detect nav above is kept — that
        // is the legitimate startup case.)
        setConfig({ configPath: path, logLevel: "info" });
        localStorage.setItem("tt_config_path", path);
        setConnectionKey((k) => k + 1);
        pushSuccess(i18n.t("messages.config_file_restored", "Config loaded"));
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.configPath]);
}
