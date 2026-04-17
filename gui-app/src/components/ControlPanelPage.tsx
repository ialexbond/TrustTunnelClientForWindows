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

// ── OverviewSkeletonCard — single card placeholder mirroring OverviewSection Card layout
function OverviewSkeletonCard({
  flex,
  maxWidth,
  body,
}: {
  flex: string;
  maxWidth?: number;
  body: React.ReactNode;
}) {
  return (
    <div
      className="rounded-[var(--radius-lg)] p-[var(--space-4)]"
      style={{
        flex,
        maxWidth,
        backgroundColor: "var(--color-bg-surface)",
        border: "1px solid var(--color-border)",
      }}
    >
      {/* Title row — icon + label (left), refresh slot (right) — matches OverviewSection Title height */}
      <div className="flex items-center justify-between mb-3" style={{ height: 32 }}>
        <div className="flex items-center gap-2 h-full">
          <Skeleton variant="card" width={20} height={20} />
          <Skeleton variant="line" width={90} height={14} />
        </div>
        <Skeleton variant="card" width={32} height={32} />
      </div>
      {body}
    </div>
  );
}

export function ServerPanelSkeleton() {
  // Mirrors OverviewSection grid: flex-wrap, gap 12px, 10 cards in 3 rows.
  // Card flex/maxWidth values copied from OverviewSection.tsx so collapse points match.
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar skeleton — 5 tab pills + separator + disconnect icon (matches ServerTabs) */}
      <div className="px-6 shrink-0">
        <div
          className="flex items-center gap-1"
          style={{ borderBottom: "1px solid var(--color-border)", paddingTop: "4px", paddingBottom: "4px" }}
        >
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} variant="card" className="flex-1" height={32} />
          ))}
          <div className="shrink-0 mx-2 self-stretch my-1.5" style={{ width: "1px", backgroundColor: "var(--color-border)" }} />
          <Skeleton variant="card" width={32} height={32} className="shrink-0" />
        </div>
      </div>

      {/* Content area — mirrors OverviewSection 10-card layout */}
      <div className="flex-1 py-4 px-6 overflow-hidden">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, width: "100%" }}>

          {/* ── Row 1: Status | Ping | Speed | Users ── */}
          <OverviewSkeletonCard
            flex="1 1 220px"
            body={
              <div className="flex flex-col items-center justify-center gap-1.5 py-1">
                <Skeleton variant="card" width={120} height={28} />
                <Skeleton variant="line" width={60} height={12} />
              </div>
            }
          />
          <OverviewSkeletonCard
            flex="1 1 140px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={70} height={32} />
              </div>
            }
          />
          {/* Speed skeleton — compact (Phase 13.UAT): меньше gap, более узкая карточка */}
          <OverviewSkeletonCard
            flex="1 1 280px"
            maxWidth={360}
            body={
              <div className="flex items-center justify-center gap-4 py-2" style={{ minHeight: 48 }}>
                <div className="flex items-center gap-1.5" style={{ minWidth: 100 }}>
                  <Skeleton variant="circle" width={24} height={24} />
                  <Skeleton variant="line" width={60} height={28} />
                </div>
                <div className="h-7 shrink-0" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
                <div className="flex items-center gap-1.5" style={{ minWidth: 100 }}>
                  <Skeleton variant="circle" width={24} height={24} />
                  <Skeleton variant="line" width={60} height={28} />
                </div>
              </div>
            }
          />
          <OverviewSkeletonCard
            flex="1 1 180px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={50} height={32} />
              </div>
            }
          />

          {/* ── Row 2: IP | Country | Uptime | Version ── */}
          <OverviewSkeletonCard
            flex="1 1 240px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={140} height={32} />
              </div>
            }
          />
          <OverviewSkeletonCard
            flex="1 1 180px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={120} height={28} />
              </div>
            }
          />
          <OverviewSkeletonCard
            flex="1 1 160px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={80} height={28} />
              </div>
            }
          />
          <OverviewSkeletonCard
            flex="1 1 220px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={100} height={32} />
              </div>
            }
          />

          {/* ── Row 3: Security (4 sub-tiles) | Load (CPU + RAM bars) ── */}
          {/* G-09: flex-basis 300 каждая — Security+Load помещаются в одну строку
              даже при minWidth 800px контейнера. Раньше split в отдельный ряд. */}
          <OverviewSkeletonCard
            flex="1 1 300px"
            body={
              <div className="grid grid-cols-2 gap-2 mt-1">
                {[1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className="rounded-[var(--radius-md)] px-3 py-2"
                    style={{ backgroundColor: "var(--color-bg-elevated)" }}
                  >
                    <Skeleton variant="line" width={70} height={12} className="mb-1.5" />
                    <Skeleton variant="line" width={50} height={12} />
                  </div>
                ))}
              </div>
            }
          />
          {/* Load skeleton — matches Screens/Overview Cards 10c (no CPU/RAM text, full skeletons) */}
          <OverviewSkeletonCard
            flex="1 1 300px"
            body={
              <div className="space-y-2.5 mt-1">
                {[1, 2].map((i) => (
                  <div key={i}>
                    <div className="flex items-center justify-between mb-1">
                      <Skeleton variant="line" width={30} height={20} />
                      <Skeleton variant="line" width={60} height={20} />
                    </div>
                    <Skeleton variant="line" width="100%" height={6} />
                  </div>
                ))}
              </div>
            }
          />
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
      // BUG-01: при auto-reconnect показываем skeleton (а не полноэкранный лоадер
      // ServerPanel.state.loading). Сбросится в false по onPanelReady.
      if (c) setIsFirstConnect(true);
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
