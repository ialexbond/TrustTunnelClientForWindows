import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { ServerPanel } from "./ServerPanel";
import { SshConnectForm, type SshCredentials } from "./server/SshConnectForm";
import { ServerSidebar, type ServerEntry } from "./ServerSidebar";
import { Button } from "../shared/ui/Button";
import { LogOut } from "lucide-react";

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

interface Props {
  onConfigExported: (configPath: string) => void;
  onSwitchToSetup: () => void;
  onNavigateToSettings?: () => void;
}

export function ControlPanelPage({ onConfigExported, onSwitchToSetup, onNavigateToSettings }: Props) {
  const { t } = useTranslation();
  const [creds, setCreds] = useState<SshCredentials | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showAddForm, setShowAddForm] = useState(false);
  const lastTsRef = useRef<string | null>(null);

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
            setShowAddForm(false);
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
            setShowAddForm(false);
            setRefreshKey(k => k + 1);
          }
        });
      }
    }, 500);
    return () => clearInterval(interval);
  }, [creds]);

  const handleConnect = useCallback((newCreds: SshCredentials) => {
    setCreds(newCreds);
    setShowAddForm(false);
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
    setCreds(null);
    setShowAddForm(false);
  }, []);

  if (loading) {
    return null;
  }

  // Build server list for sidebar
  const servers: ServerEntry[] = creds
    ? [{ id: "main", host: creds.host, port: creds.port, status: "connected" as const }]
    : [];

  const selectedId = creds ? "main" : null;

  return (
    <div className="h-full flex overflow-hidden">
      {/* Sidebar */}
      <ServerSidebar
        servers={servers}
        selectedId={selectedId}
        onSelect={() => { /* single server for now */ }}
        onAddServer={() => {
          if (creds) {
            // Already connected — disconnect first, then show form
            handleDisconnect();
          }
          setShowAddForm(true);
        }}
        onDisconnect={() => handleDisconnect()}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!creds ? (
          /* No credentials — show SshConnectForm */
          <div className="flex-1 flex flex-col overflow-hidden">
            <SshConnectForm onConnect={handleConnect} />
          </div>
        ) : (
          /* Connected — show header + ServerPanel (tabs coming in next iteration) */
          <>
            {/* Header */}
            <div className="h-[40px] flex items-center justify-between px-3 shrink-0 border-b border-[var(--color-border)]">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--color-status-connected)" }} />
                <span className="text-xs font-medium text-[var(--color-text-primary)]">
                  {creds.host}:{creds.port}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDisconnect}
              >
                <LogOut className="w-3.5 h-3.5" />
                {t("control.disconnect")}
              </Button>
            </div>

            {/* ServerPanel */}
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
              onConfigExported={(path) => {
                onConfigExported(path);
                if (onNavigateToSettings) onNavigateToSettings();
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
