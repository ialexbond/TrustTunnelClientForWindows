import { useEffect, useRef } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useActivityLog } from "./useActivityLog";

/**
 * Fire-once hook: logs `app.start version=X.Y.Z` to the activity log on
 * first mount. Falls back to `version=unknown` if `getVersion()` rejects.
 *
 * WR-05 fix: explicit `didRunRef` guard instead of exhaustive-deps disable.
 * Under React.StrictMode (DEV) effects run twice — without the guard the
 * activity log would receive two `app.start` entries per cold boot.
 *
 * Extracted from App.tsx verbatim (Phase 12.5, D-03).
 */
export function useActivityLogStartup() {
  const { log: activityLog } = useActivityLog();
  const didRunRef = useRef(false);

  useEffect(() => {
    if (didRunRef.current) return;
    didRunRef.current = true;
    getVersion()
      .then((version) => {
        activityLog("STATE", `app.start version=${version}`, "App");
      })
      .catch(() => {
        activityLog("STATE", "app.start version=unknown", "App");
      });
  }, [activityLog]);
}
