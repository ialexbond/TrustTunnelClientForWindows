import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { ServerPanel } from "./ServerPanel";
import { SshConnectForm, type SshCredentials } from "./server/SshConnectForm";
import { Button } from "../shared/ui/Button";
import { LogOut } from "lucide-react";
import { deobfuscate } from "../shared/utils/obfuscation";

async function readStoredCredentials(): Promise<SshCredentials | null> {
  try {
    // Primary: read from Rust backend (file-based)
    const obj = await invoke<{ host: string; port: string; user: string; password: string; keyPath: string } | null>("load_ssh_credentials");
    if (obj && obj.host && (obj.password || obj.keyPath)) {
      return {
        host: obj.host,
        port: obj.port || "22",
        user: obj.user || "root",
        password: obj.password ? deobfuscate(obj.password) : "",
        keyPath: obj.keyPath || undefined,
      };
    }
    // Migrate from localStorage if present (one-time migration)
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
          password: legacy.password ? deobfuscate(legacy.password) : "",
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
  const lastTsRef = useRef<string | null>(null);

  // Load credentials from Rust backend on mount
  useEffect(() => {
    readStoredCredentials().then((c) => {
      setCreds(c);
      setLoading(false);
    });
  }, []);

  // Watch for a "force refresh" signal from the wizard (timestamp changes)
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
      // Also pick up creds if we have none
      if (!creds) {
        readStoredCredentials().then((fresh) => {
          if (fresh) {
            setCreds(fresh);
            setRefreshKey(k => k + 1);
          }
        });
      }
    }, 500);
    return () => clearInterval(interval);
  }, [creds]);

  const handleConnect = useCallback((newCreds: SshCredentials) => {
    setCreds(newCreds);
    setRefreshKey(k => k + 1);
  }, []);

  const handleDisconnect = useCallback(() => {
    invoke("clear_ssh_credentials").catch(() => {});
    localStorage.removeItem("trusttunnel_control_refresh");
    setCreds(null);
  }, []);

  if (loading) {
    return null;
  }

  if (!creds) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <SshConnectForm onConnect={handleConnect} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-end px-4 shrink-0"
        style={{
          height: 52,
          backgroundColor: "var(--color-bg-primary)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <Button
          variant="ghost"
          size="sm"
          icon={<LogOut className="w-3.5 h-3.5" />}
          onClick={handleDisconnect}
        >
          {t("control.disconnect")}
        </Button>
      </div>

      {/* ServerPanel — refreshKey forces re-mount after wizard install */}
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
        onConfigExported={(path) => {
          onConfigExported(path);
          if (onNavigateToSettings) onNavigateToSettings();
        }}
      />
    </div>
  );
}
