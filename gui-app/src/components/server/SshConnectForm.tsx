import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Server, Loader2, AlertCircle, Lock, Key, FileKey } from "lucide-react";
import { Input } from "../../shared/ui/Input";
import { PasswordInput } from "../../shared/ui/PasswordInput";
import { Button } from "../../shared/ui/Button";
import { translateSshError } from "../../shared/utils/translateSshError";

export interface SshCredentials {
  host: string;
  port: string;
  user: string;
  password: string;
  keyPath?: string;
}

interface Props {
  onConnect: (creds: SshCredentials) => void;
}

type AuthMode = "password" | "key";

function obfuscate(value: string): string {
  return "b64:" + btoa(unescape(encodeURIComponent(value)));
}

export function SshConnectForm({ onConnect }: Props) {
  const { t } = useTranslation();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("password");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  const handleSelectKey = async () => {
    try {
      const selected = await open({
        title: t("control.select_key_title"),
        filters: [
          { name: "All Files", extensions: ["*"] },
        ],
        multiple: false,
      });
      if (selected) {
        setKeyPath(typeof selected === "string" ? selected : selected);
      }
    } catch {
      // user cancelled
    }
  };

  const isValid =
    host.trim() &&
    (authMode === "password" ? password.trim() : keyPath.trim());

  const handleConnect = async () => {
    if (!isValid) return;
    setConnecting(true);
    setError("");

    try {
      const params: Record<string, unknown> = {
        host: host.trim(),
        port: parseInt(port) || 22,
        user: user.trim() || "root",
        password: authMode === "password" ? password : "",
      };
      if (authMode === "key" && keyPath) {
        params.keyPath = keyPath;
      }

      await invoke("check_server_installation", params);

      const creds: SshCredentials = {
        host: host.trim(),
        port: port || "22",
        user: user.trim() || "root",
        password: authMode === "password" ? password : "",
        keyPath: authMode === "key" ? keyPath : undefined,
      };
      localStorage.setItem(
        "trusttunnel_control_ssh",
        JSON.stringify({
          host: creds.host,
          port: creds.port,
          user: creds.user,
          password: creds.password ? obfuscate(creds.password) : "",
          keyPath: creds.keyPath || "",
        })
      );

      onConnect(creds);
    } catch (e) {
      setError(translateSshError(String(e), t));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center py-8">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-6">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3"
            style={{ backgroundColor: "rgba(99, 102, 241, 0.15)" }}
          >
            <Server className="w-6 h-6" style={{ color: "var(--color-accent-400)" }} />
          </div>
          <h2 className="text-lg font-bold mb-1" style={{ color: "var(--color-text-primary)" }}>
            {t("control.ssh_title")}
          </h2>
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {t("control.ssh_description")}
          </p>
        </div>

        {/* Form */}
        <div
          className="rounded-[var(--radius-xl)] p-5 space-y-4"
          style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
        >
          {/* Host + Port */}
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <Input
                label={t("labels.server_ip")}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="123.45.67.89"
              />
            </div>
            <div className="w-20">
              <Input
                label={t("labels.port")}
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                placeholder="22"
              />
            </div>
          </div>

          {/* Username */}
          <Input
            label={t("labels.username")}
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="root"
          />

          {/* Auth mode toggle */}
          <div>
            <label className="block text-xs font-medium mb-2" style={{ color: "var(--color-text-secondary)" }}>
              {t("control.auth_method")}
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setAuthMode("password")}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-xs font-medium transition-all duration-200"
                style={{
                  backgroundColor: authMode === "password" ? "var(--color-accent-500)" : "var(--color-bg-elevated)",
                  color: authMode === "password" ? "white" : "var(--color-text-secondary)",
                  border: `1px solid ${authMode === "password" ? "var(--color-accent-500)" : "var(--color-border)"}`,
                }}
              >
                <Key className="w-3.5 h-3.5" />
                {t("control.auth_password")}
              </button>
              <button
                onClick={() => setAuthMode("key")}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-xs font-medium transition-all duration-200"
                style={{
                  backgroundColor: authMode === "key" ? "var(--color-accent-500)" : "var(--color-bg-elevated)",
                  color: authMode === "key" ? "white" : "var(--color-text-secondary)",
                  border: `1px solid ${authMode === "key" ? "var(--color-accent-500)" : "var(--color-border)"}`,
                }}
              >
                <FileKey className="w-3.5 h-3.5" />
                {t("control.auth_key")}
              </button>
            </div>
          </div>

          {/* Password or Key selector */}
          {authMode === "password" ? (
            <PasswordInput
              label={t("labels.ssh_password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="********"
            />
          ) : (
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--color-text-secondary)" }}>
                {t("control.key_file")}
              </label>
              <div className="flex gap-2">
                <div
                  className="flex-1 flex items-center px-3 py-2.5 rounded-[var(--radius-lg)] text-sm truncate cursor-pointer"
                  style={{
                    backgroundColor: "var(--color-input-bg)",
                    border: "1px solid var(--color-input-border)",
                    color: keyPath ? "var(--color-text-primary)" : "var(--color-text-muted)",
                  }}
                  onClick={handleSelectKey}
                >
                  <FileKey className="w-4 h-4 shrink-0 mr-2" style={{ color: "var(--color-text-muted)" }} />
                  <span className="truncate text-xs">
                    {keyPath ? keyPath.split(/[/\\]/).pop() : t("control.select_key")}
                  </span>
                </div>
                <Button variant="secondary" size="sm" onClick={handleSelectKey}>
                  {t("control.browse")}
                </Button>
              </div>
              {keyPath && (
                <p className="text-[10px] mt-1 truncate" style={{ color: "var(--color-text-muted)" }}>
                  {keyPath}
                </p>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              className="flex items-start gap-2 p-3 rounded-[var(--radius-md)]"
              style={{ backgroundColor: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)" }}
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--color-danger-400)" }} />
              <p className="text-[11px]" style={{ color: "var(--color-danger-400)" }}>{error}</p>
            </div>
          )}

          {/* Connect button */}
          <Button
            variant="primary"
            fullWidth
            icon={connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Server className="w-4 h-4" />}
            disabled={!isValid || connecting}
            onClick={handleConnect}
          >
            {connecting ? t("control.connecting") : t("control.connect")}
          </Button>

          {/* Security note */}
          <div className="flex items-center justify-center gap-1.5">
            <Lock className="w-3 h-3" style={{ color: "var(--color-text-muted)" }} />
            <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
              {t("control.remember")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
