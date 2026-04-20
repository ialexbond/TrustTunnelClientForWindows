import { useState } from "react";

/**
 * Domain hook for danger-zone loading flags (reboot, uninstall).
 * Actions live in ServerStatusSection (reboot) and DangerZoneSection (uninstall)
 * and call invoke() + useConfirm() directly.
 */
export function useDangerZoneState() {
  const [rebooting, setRebooting] = useState(false);
  const [uninstallLoading, setUninstallLoading] = useState(false);

  return {
    rebooting,
    setRebooting,
    uninstallLoading,
    setUninstallLoading,
  };
}

export type DangerZoneState = ReturnType<typeof useDangerZoneState>;
