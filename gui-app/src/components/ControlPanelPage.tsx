import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ServerPanel } from "./ServerPanel";
import { SshConnectForm, type SshCredentials } from "./server/SshConnectForm";
import { Button } from "../shared/ui/Button";
import { LogOut } from "lucide-react";

function deobfuscate(value: string): string {
  if (value.startsWith("b64:")) {
    try {
      return decodeURIComponent(escape(atob(value.slice(4))));
    } catch {
      return value;
    }
  }
  return value;
}

function readStoredCredentials(): SshCredentials | null {
  try {
    const raw = localStorage.getItem("trusttunnel_control_ssh");
    if (!raw) return null;
    const obj = JSON.parse(raw);
    // Need either password or keyPath
    if (!obj.host || (!obj.password && !obj.keyPath)) return null;
    return {
      host: obj.host,
      port: obj.port || "22",
      user: obj.user || "root",
      password: obj.password ? deobfuscate(obj.password) : "",
      keyPath: obj.keyPath || undefined,
    };
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
  const [creds, setCreds] = useState<SshCredentials | null>(readStoredCredentials);
  const [refreshKey, setRefreshKey] = useState(0);

  // Re-read credentials when localStorage changes (e.g. after wizard completes)
  useEffect(() => {
    const interval = setInterval(() => {
      const fresh = readStoredCredentials();
      if (fresh && !creds) {
        setCreds(fresh);
        setRefreshKey(k => k + 1);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [creds]);

  const handleConnect = useCallback((newCreds: SshCredentials) => {
    setCreds(newCreds);
    setRefreshKey(k => k + 1);
  }, []);

  const handleDisconnect = useCallback(() => {
    localStorage.removeItem("trusttunnel_control_ssh");
    setCreds(null);
  }, []);

  if (!creds) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <SshConnectForm onConnect={handleConnect} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div
        className="flex justify-end px-4 py-2 shrink-0 sticky top-0 z-10"
        style={{
          backgroundColor: "var(--color-bg-secondary)",
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

      <ServerPanel
        key={refreshKey}
        host={creds.host}
        port={creds.port}
        sshUser={creds.user}
        sshPassword={creds.password}
        sshKeyPath={creds.keyPath}
        onSwitchToSetup={onSwitchToSetup}
        onClearConfig={() => {}}
        onConfigExported={(path) => {
          onConfigExported(path);
          if (onNavigateToSettings) onNavigateToSettings();
        }}
      />
    </div>
  );
}
