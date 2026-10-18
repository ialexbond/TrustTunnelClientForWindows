import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../shared/ui/Button";
import type { VpnStatus } from "../shared/types";

interface NetworkGuardBannerProps {
  status: VpnStatus;
}

/** Recovery for a failed VPN core while the GUI session is still running. */
export function NetworkGuardBanner({ status }: NetworkGuardBannerProps) {
  const { t } = useTranslation();
  const [armed, setArmed] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const alive = useRef(false);
  const revision = useRef(0);
  const releasePending = useRef(false);
  const invalidateSnapshot = useCallback(() => { ++revision.current; }, []);

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const current = await invoke<boolean>("network_guard_status");
      if (typeof current !== "boolean") throw new Error("network-guard-failed");
      if (alive.current && request === revision.current) {
        setArmed(current);
        setFailed(false);
      }
    } catch {
      if (alive.current && request === revision.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    const subscription = listen<{ armed: boolean }>("network-guard-changed", ({ payload }) => {
      if (disposed) return;
      invalidateSnapshot();
      if (typeof payload.armed !== "boolean") {
        setFailed(true);
        return;
      }
      setArmed(payload.armed);
      setFailed(false);
    });
    void subscription.then(() => {
      if (!disposed) void refresh();
    }).catch(() => {
      if (!disposed) void refresh();
    });
    return () => {
      disposed = true;
      alive.current = false;
      invalidateSnapshot();
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [status, refresh, invalidateSnapshot]);

  const release = async () => {
    if (releasePending.current) return;
    releasePending.current = true;
    setReleasing(true);
    try {
      // Normal disconnect serializes teardown and releases session protection. Only an event
      // or a fresh query confirms that the block was removed; the click itself never does.
      await invoke("vpn_disconnect");
      await refresh();
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      releasePending.current = false;
      if (alive.current) setReleasing(false);
    }
  };

  if ((status !== "disconnected" && status !== "error") || (armed !== true && !failed)) return null;

  return (
    <div className="w-full max-w-[1000px] mx-auto px-4 pt-3 shrink-0">
      <div
        role="status"
        className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] p-3 bg-[var(--color-warning-tint-08)] border border-[var(--color-border)]"
      >
        <ShieldCheck className="w-4 h-4 shrink-0 text-[var(--color-warning-fg)]" aria-hidden="true" />
        <div className="flex-1 min-w-[200px] text-sm text-[var(--color-text-primary)]">
          <p>{t(armed === true ? "network_guard.blocked" : "errors.network_guard_failed")}</p>
          {failed && armed === true && (
            <p role="alert" className="mt-1">{t("errors.network_guard_failed")}</p>
          )}
        </div>
        <Button variant="secondary" size="sm" loading={releasing} onClick={() => void release()}>
          {t("network_guard.release")}
        </Button>
      </div>
    </div>
  );
}
