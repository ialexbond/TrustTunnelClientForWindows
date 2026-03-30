import { useState, useCallback, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { UpdateInfo } from "../types";

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export function useUpdateChecker() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({
    available: false, latestVersion: "", currentVersion: "",
    downloadUrl: "", sha256: "", releaseNotes: "", checking: false,
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
      const asset =
        assets.find((a: { name: string }) => a.name.endsWith(".zip")) ||
        assets.find((a: { name: string }) => a.name.endsWith(".exe") || a.name.endsWith(".msi"));
      // Look for SHA256 checksum: either a .sha256 asset or a pattern in release notes
      const sha256Asset = assets.find((a: { name: string }) => a.name.endsWith(".sha256"));
      let sha256 = "";
      if (sha256Asset) {
        try {
          const hashRes = await fetch(sha256Asset.browser_download_url);
          if (hashRes.ok) sha256 = (await hashRes.text()).trim().split(/\s/)[0];
        } catch { /* checksum fetch is optional */ }
      } else {
        // Try to extract from release notes: "SHA256: <hex>" pattern
        const match = (data.body || "").match(/SHA256:\s*([a-fA-F0-9]{64})/);
        if (match) sha256 = match[1];
      }

      setUpdateInfo({
        available: isNewer,
        latestVersion: latestTag,
        currentVersion,
        downloadUrl: asset?.browser_download_url || data.html_url || "",
        sha256,
        releaseNotes: data.body || "",
        checking: false,
      });
    } catch (e) {
      console.warn("Update check failed:", e);
      setUpdateInfo(prev => ({ ...prev, checking: false }));
    }
  }, []);

  useEffect(() => { checkForUpdates(true); }, [checkForUpdates]);

  return { updateInfo, checkForUpdates };
}
