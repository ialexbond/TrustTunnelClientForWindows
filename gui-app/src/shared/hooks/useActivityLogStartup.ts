import { useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useActivityLog } from "./useActivityLog";

/**
 * Fire-once hook: logs `app.start version=X.Y.Z` to the activity log on
 * first mount. Falls back to `version=unknown` if `getVersion()` rejects.
 *
 * Extracted from App.tsx verbatim (Phase 12.5, D-03).
 */
export function useActivityLogStartup() {
  const { log: activityLog } = useActivityLog();

  useEffect(() => {
    getVersion()
      .then((version) => {
        activityLog("STATE", `app.start version=${version}`, "App");
      })
      .catch(() => {
        activityLog("STATE", "app.start version=unknown", "App");
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
