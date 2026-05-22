import { useState, useCallback, useEffect, useMemo } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { UpdateInfo } from "../types";

// Asset name pattern for this edition (Pro)
const ASSET_PATTERN = /Pro.*setup.*\.exe$/i;

// Background check interval — 24h per REQ-18-UPDATE-DETECTION-03 + D-2.4
// (was 6h до Phase 18). App startup check unchanged.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Plan 18-03 backend contract — match snake_case wire format from Tauri serde.
// Tauri авто-маппит camelCase JS keys → snake_case Rust fields на boundary,
// поэтому на проводе мы видим snake_case (как объявлено в Rust struct).
interface SidecarVersionInfo {
  current_version: string;
  latest_version: string;
  latest_tag: string;
  available: boolean;
  asset_download_url: string;
  asset_size_bytes: number;
}

// Indiv-fields SSH params shape — matches Phase 17.1 mtproto_install pattern
// (PLAN-REVIEW Blocker #1 fix) + Plan 18-03 check_sidecar_version signature.
export interface UpdateCheckerSshParams {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath?: string;
  keyData?: string;
}

function compareVersions(a: string, b: string): number {
  // Strip pre-release suffixes: "2.1.1-test" → "2.1.1"
  const clean = (v: string) => v.replace(/-.*$/, "");
  const pa = clean(a).split(".").map(Number);
  const pb = clean(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Dual update detection hook (Phase 18 REQ-18-UPDATE-DETECTION-01..04).
 *
 * Возвращает независимые флаги для app + sidecar обновлений + helpers для
 * per-version dismissal и server-aware sidecar check'ов.
 *
 * Backwards-compat: `useUpdateChecker()` (no args) продолжает работать —
 * `sshParams` опционален с default `undefined`, App.tsx:81 не модифицирован.
 * Existing fields `updateInfo.available` / `latestVersion` / `downloadUrl`
 * остаются (alias `available = appAvailable` для AboutPanel consumer).
 *
 * Two-stage detection (OQ-5):
 * - Stage 1 (app startup, без SSH): GitHub API → `appAvailable`
 * - Stage 2 (user connects к server): `checkSidecarForServer(sshParams)` →
 *   `sidecarAvailable`
 *
 * UpdateBanner показывается ТОЛЬКО когда `sidecarAvailable && !sidecarDismissed`.
 * Dot indicator показывается когда `appAvailable || sidecarAvailable` (D-2.5).
 *
 * Per-version dismissal (REQ-18-UPDATE-FLOW-02):
 * - localStorage key `tt_dismissed_update_<version>` = `"true"`
 * - Когда выходит более новая sidecar версия — `sidecarDismissed = false`
 *   автоматически (key для новой версии не существует)
 *
 * Silent fail (D-2.x): GitHub API errors / Tauri invoke rejections →
 * `console.warn` only, state stays consistent (checking flags returns to false,
 * available flags остаются prior value либо false).
 *
 * D-29: hook НЕ logging versions / paths / secrets в activityLog. Только
 * console.warn для debug visibility (DevTools-only).
 */
export function useUpdateChecker(_sshParams?: UpdateCheckerSshParams | null) {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({
    // EXISTING (backwards-compat)
    available: false,
    latestVersion: "",
    currentVersion: "",
    downloadUrl: "",
    sha256: "",
    releaseNotes: "",
    checking: false,
    // NEW (Phase 18)
    appAvailable: false,
    sidecarAvailable: false,
    sidecarCurrentVersion: "",
    sidecarLatestVersion: "",
    sidecarLatestTag: "",
    sidecarDownloadUrl: "",
    sidecarDismissed: false,
    sidecarChecking: false,
    lastChecked: null,
  });

  const checkForUpdates = useCallback(async (_silent = false) => {
    setUpdateInfo(prev => ({ ...prev, checking: true }));
    try {
      const currentVersion = await getVersion();
      const res = await fetch(
        "https://api.github.com/repos/ialexbond/TrustTunnelClientForWindows/releases/latest",
        { headers: { "Accept": "application/vnd.github.v3+json" } }
      );
      if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
      const data = await res.json();
      const latestTag = (data.tag_name || "").replace(/^v\.?/, "");
      const isNewer = compareVersions(latestTag, currentVersion) > 0;
      const assets = data.assets || [];

      // Find setup.exe matching this edition (Pro)
      const asset = assets.find((a: { name: string }) => ASSET_PATTERN.test(a.name));

      // Look for SHA256 checksum: matching .sha256 asset or pattern in release notes
      const sha256Asset = asset
        ? assets.find((a: { name: string }) => a.name === asset.name + ".sha256")
          || assets.find((a: { name: string }) => a.name.endsWith(".sha256") && ASSET_PATTERN.test(a.name.replace(".sha256", "")))
        : assets.find((a: { name: string }) => a.name.endsWith(".sha256"));
      let sha256 = "";
      if (sha256Asset) {
        try {
          const hashRes = await fetch(sha256Asset.browser_download_url);
          if (hashRes.ok) sha256 = (await hashRes.text()).trim().split(/\s/)[0];
        } catch { /* checksum fetch is optional */ }
      } else {
        const match = (data.body || "").match(/SHA256:\s*([a-fA-F0-9]{64})/);
        if (match) sha256 = match[1];
      }

      const nowIso = new Date().toISOString();
      setUpdateInfo(prev => ({
        ...prev,
        available: isNewer,        // EXISTING — backwards-compat alias
        appAvailable: isNewer,     // NEW (Phase 18)
        latestVersion: latestTag,
        currentVersion,
        downloadUrl: asset?.browser_download_url || data.html_url || "",
        sha256,
        releaseNotes: data.body || "",
        checking: false,
        lastChecked: nowIso,
      }));
      // tt_last_update_check для 24h cadence rate-limit + debug visibility
      // (CLAUDE.md localStorage table)
      localStorage.setItem("tt_last_update_check", nowIso);
    } catch (e) {
      // Silent fail per D-2.x — DevTools-only visibility
      console.warn("Update check failed:", e);
      setUpdateInfo(prev => ({ ...prev, checking: false }));
    }
  }, []);

  /**
   * Sidecar version detection (REQ-18-UPDATE-DETECTION-02).
   *
   * Вызывается parent'ом когда user подключается к server (sshParams known).
   * Invokes `check_sidecar_version` Tauri command (Plan 18-03 contract —
   * individual fields signature, Phase 17.1 mtproto_install precedent).
   *
   * При detect новой версии (latest changes от 1.0.33 → 1.0.34) —
   * `sidecarDismissed` automatically `false` потому что
   * `tt_dismissed_update_1.0.34` key отсутствует (REQ-18-UPDATE-FLOW-02
   * per-version dismissal scope).
   *
   * Silent fail (D-2.x): любая ошибка backend → state.sidecarAvailable
   * остаётся false, exception не бросается.
   */
  const checkSidecarForServer = useCallback(
    async (sshParams: UpdateCheckerSshParams) => {
      setUpdateInfo(prev => ({ ...prev, sidecarChecking: true }));
      try {
        // Tauri auto-maps camelCase JS keys → snake_case Rust fields на boundary.
        // Plan 18-03 frozen contract: individual fields signature
        // (host, port, user, password, key_path, key_data). См. SUMMARY Plan 18-03.
        const info = await invoke<SidecarVersionInfo>("check_sidecar_version", {
          host: sshParams.host,
          port: sshParams.port,
          user: sshParams.user,
          password: sshParams.password,
          keyPath: sshParams.keyPath ?? null,
          keyData: sshParams.keyData ?? null,
        });

        // Per-version dismissal lookup (REQ-18-UPDATE-FLOW-02)
        const dismissedKey = `tt_dismissed_update_${info.latest_version}`;
        const dismissed = localStorage.getItem(dismissedKey) === "true";

        const nowIso = new Date().toISOString();
        setUpdateInfo(prev => ({
          ...prev,
          sidecarAvailable: info.available,
          sidecarCurrentVersion: info.current_version,
          sidecarLatestVersion: info.latest_version,
          sidecarLatestTag: info.latest_tag,
          sidecarDownloadUrl: info.asset_download_url,
          sidecarDismissed: dismissed,
          sidecarChecking: false,
          lastChecked: nowIso,
        }));
        localStorage.setItem("tt_last_update_check", nowIso);
      } catch (e) {
        // Silent fail per D-2.x — DevTools-only visibility
        console.warn("Sidecar update check failed:", e);
        setUpdateInfo(prev => ({ ...prev, sidecarChecking: false }));
      }
    },
    [],
  );

  /**
   * Per-version dismissal (REQ-18-UPDATE-FLOW-02).
   *
   * Записывает `tt_dismissed_update_<version> = "true"` в localStorage и
   * flips state.sidecarDismissed = true. НЕ trigger refetch GitHub —
   * флаг живёт до выхода более новой версии.
   *
   * Caller — обычно UpdateBanner X-крестик через parent (Plan 18-02 banner
   * имеет `onDismiss` callback; wire-up в Plan 18-06 либо отдельный wire task).
   */
  const dismissSidecarUpdate = useCallback((version: string) => {
    const key = `tt_dismissed_update_${version}`;
    localStorage.setItem(key, "true");
    setUpdateInfo(prev => ({ ...prev, sidecarDismissed: true }));
  }, []);

  // Check on startup + periodic background check every 24 hours
  // (REQ-18-UPDATE-DETECTION-03). Sidecar check НЕ included здесь — он
  // server-aware и зависит от sshParams (Stage 2 detection, OQ-5).
  useEffect(() => {
    checkForUpdates(true);
    const interval = setInterval(() => checkForUpdates(true), CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [checkForUpdates]);

  // ─── Debug override (for UAT visual preview only) ─────────────────────
  // Toggleable через AboutPanel → «Force показать update flow». Слушает
  // custom event `tt-debug-update-toggle` чтобы все instances hook'а
  // переключались live без reload. localStorage hydration на mount —
  // если флаг включён до restart, banner отобразится сразу.
  const [debugForceSidecar, setDebugForceSidecar] = useState<boolean>(
    () => localStorage.getItem("tt_debug_force_sidecar_update") === "true",
  );
  useEffect(() => {
    const handler = () => {
      setDebugForceSidecar(
        localStorage.getItem("tt_debug_force_sidecar_update") === "true",
      );
    };
    window.addEventListener("tt-debug-update-toggle", handler);
    return () => window.removeEventListener("tt-debug-update-toggle", handler);
  }, []);

  const effectiveUpdateInfo = useMemo<UpdateInfo>(() => {
    if (!debugForceSidecar) return updateInfo;
    return {
      ...updateInfo,
      sidecarAvailable: true,
      sidecarCurrentVersion: updateInfo.sidecarCurrentVersion || "3.0.0",
      sidecarLatestVersion: updateInfo.sidecarLatestVersion || "3.0.1",
      sidecarLatestTag: updateInfo.sidecarLatestTag || "v3.0.1",
      sidecarDownloadUrl:
        updateInfo.sidecarDownloadUrl ||
        "https://github.com/TrustTunnel/TrustTunnel/releases/download/v3.0.1/trusttunnel-v3.0.1-linux-x86_64.tar.gz",
      sidecarDismissed: false,
    };
  }, [updateInfo, debugForceSidecar]);

  return {
    updateInfo: effectiveUpdateInfo,
    checkForUpdates,
    checkSidecarForServer,
    dismissSidecarUpdate,
  };
}
