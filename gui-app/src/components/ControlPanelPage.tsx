import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ServerPanel } from "./ServerPanel";
import { SshConnectForm, type SshCredentials } from "./server/SshConnectForm";
import { Skeleton } from "../shared/ui/Skeleton";

async function readStoredCredentials(): Promise<SshCredentials | null> {
  try {
    const obj = await invoke<{ host: string; port: string; user: string; password: string; keyPath: string } | null>("load_ssh_credentials");
    if (obj && obj.host && (obj.password || obj.keyPath)) {
      return {
        host: obj.host,
        port: obj.port || "22",
        user: obj.user || "root",
        password: obj.password || "",
        keyPath: obj.keyPath || undefined,
      };
    }
    const raw = localStorage.getItem("trusttunnel_control_ssh");
    if (raw) {
      const legacy = JSON.parse(raw);
      if (legacy.host && (legacy.password || legacy.keyPath)) {
        await invoke("save_ssh_credentials", {
          host: legacy.host,
          port: legacy.port || "22",
          user: legacy.user || "root",
          password: legacy.password || "",
          keyPath: legacy.keyPath || null,
        });
        localStorage.removeItem("trusttunnel_control_ssh");
        return {
          host: legacy.host,
          port: legacy.port || "22",
          user: legacy.user || "root",
          password: legacy.password || "",
          keyPath: legacy.keyPath || undefined,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════
// ServerPanelSkeleton — shown during first SSH connect
// ═══════════════════════════════════════════════════════

function ServerPanelSkeleton() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar skeleton - 5 tab pills + separator + disconnect icon */}
      <div
        className="flex items-center shrink-0 gap-1 px-6 py-1"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} variant="card" className="flex-1" height={32} />
        ))}
        <div className="shrink-0 mx-2 self-stretch my-1.5" style={{ width: "1px", backgroundColor: "var(--color-border)" }} />
        <Skeleton variant="card" width={32} height={32} className="shrink-0" />
      </div>
      {/* Content area skeleton — mirrors OverviewSection Default layout */}
      <div className="flex-1 px-6 py-4 space-y-4">
        {/* Block 1: Status card — status row + info rows */}
        <div
          className="rounded-[var(--radius-lg)] p-[var(--space-4)]"
          style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <Skeleton variant="card" width={10} height={10} className="rounded-full" />
              <Skeleton variant="line" width={80} height={14} />
            </div>
            <Skeleton variant="card" width={28} height={28} />
          </div>
          <div style={{ borderTop: "1px solid var(--color-border)" }} className="pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <Skeleton variant="line" width={60} height={12} />
              <Skeleton variant="line" width={40} height={12} />
            </div>
            <div className="flex items-center justify-between">
              <Skeleton variant="line" width={70} height={12} />
              <Skeleton variant="line" width={120} height={12} />
            </div>
          </div>
        </div>
        {/* Block 2: TLS Certificate card */}
        <div
          className="rounded-[var(--radius-lg)] p-[var(--space-4)]"
          style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Skeleton variant="card" width={16} height={16} />
            <Skeleton variant="line" width={130} height={14} />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Skeleton variant="line" width={40} height={12} />
              <Skeleton variant="line" width={90} height={12} />
            </div>
            <div className="flex items-center justify-between">
              <Skeleton variant="line" width={100} height={12} />
              <Skeleton variant="line" width={110} height={12} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// Props
// ═══════════════════════════════════════════════════════

interface Props {
  onConfigExported: (configPath: string) => void;
  onSwitchToSetup: () => void;
  onNavigateToSettings?: () => void;
}

export function ControlPanelPage({ onConfigExported, onSwitchToSetup, onNavigateToSettings }: Props) {
  const [creds, setCreds] = useState<SshCredentials | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastTsRef = useRef<string | null>(null);

  // First-connect skeleton state (D-07/D-08/D-09)
  const [isFirstConnect, setIsFirstConnect] = useState(false);

  // Persisted last SSH host/user/port (D-10/D-11) — restored on next visit
  const [lastHost, setLastHost] = useState<string>(
    () => localStorage.getItem("tt_ssh_last_host") ?? ""
  );
  const [lastUser, setLastUser] = useState<string>(
    () => localStorage.getItem("tt_ssh_last_user") ?? "root"
  );
  const [lastPort, setLastPort] = useState<string>(
    () => localStorage.getItem("tt_ssh_last_port") ?? "22"
  );

  useEffect(() => {
    readStoredCredentials().then((c) => {
      setCreds(c);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const ts = localStorage.getItem("trusttunnel_control_refresh");
      const lastTs = lastTsRef.current;
      if (ts && ts !== lastTs) {
        lastTsRef.current = ts;
        readStoredCredentials().then((fresh) => {
          if (fresh) {
            setCreds(fresh);
            setRefreshKey(k => k + 1);
          } else {
            setCreds(null);
          }
        });
      }
      if (!creds) {
        readStoredCredentials().then((fresh) => {
          if (fresh) {
            setCreds(fresh);
            setRefreshKey(k => k + 1);
          }
        });
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [creds]);

  const handleConnect = useCallback((newCreds: SshCredentials) => {
    setIsFirstConnect(true);
    setLastHost(newCreds.host);
    setLastUser(newCreds.user);
    setLastPort(newCreds.port);
    localStorage.setItem("tt_ssh_last_host", newCreds.host);
    localStorage.setItem("tt_ssh_last_user", newCreds.user);
    localStorage.setItem("tt_ssh_last_port", newCreds.port);
    setCreds(newCreds);
    setRefreshKey(k => k + 1);
  }, []);

  const handlePortChanged = useCallback(async (newPort: number) => {
    if (!creds) return;
    const updated = { ...creds, port: newPort.toString() };
    setCreds(updated);
    try {
      await invoke("save_ssh_credentials", {
        host: updated.host,
        port: updated.port,
        user: updated.user,
        password: updated.password,
        keyPath: updated.keyPath || null,
      });
    } catch (e) {
      console.error("Failed to persist updated SSH port:", e);
    }
  }, [creds]);

  const handleDisconnect = useCallback(() => {
    invoke("clear_ssh_credentials").catch(() => {});
    localStorage.removeItem("trusttunnel_control_refresh");
    setIsFirstConnect(false);
    // Per D-10: lastHost/lastUser/lastPort are NOT cleared on disconnect
    setCreds(null);
  }, []);

  if (loading) {
    return null;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {!creds ? (
        <SshConnectForm
          onConnect={handleConnect}
          initialHost={lastHost}
          initialUser={lastUser}
          initialPort={lastPort}
        />
      ) : (
        <>
          {isFirstConnect && <ServerPanelSkeleton />}
          <div style={{ display: isFirstConnect ? "none" : "flex", flexDirection: "column", height: "100%" }}>
            <ServerPanel
              key={refreshKey}
              host={creds.host}
              port={creds.port}
              sshUser={creds.user}
              sshPassword={creds.password}
              sshKeyPath={creds.keyPath}
              onSwitchToSetup={onSwitchToSetup}
              onClearConfig={() => {}}
              onDisconnect={handleDisconnect}
              onPortChanged={handlePortChanged}
              onPanelReady={() => setIsFirstConnect(false)}
              onConfigExported={(path) => {
                onConfigExported(path);
                if (onNavigateToSettings) onNavigateToSettings();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
