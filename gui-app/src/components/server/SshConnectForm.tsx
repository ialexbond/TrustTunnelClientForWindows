import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Server, Lock, Key, FileKey, ClipboardPaste } from "lucide-react";
import { Input } from "../../shared/ui/Input";
import { PasswordInput } from "../../shared/ui/PasswordInput";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { translateSshError } from "../../shared/utils/translateSshError";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { formatError } from "../../shared/utils/formatError";

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
type KeyInputMode = "file" | "paste";

export function SshConnectForm({ onConnect }: Props) {
  const { t } = useTranslation();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [keyData, setKeyData] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("password");
  const [keyInputMode, setKeyInputMode] = useState<KeyInputMode>("file");
  const [connecting, setConnecting] = useState(false);
  const pushSuccess = useSnackBar();

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
    (authMode === "password"
      ? password.trim()
      : keyInputMode === "file" ? keyPath.trim() : keyData.trim());

  const handleConnect = async () => {
    if (!isValid) return;
    setConnecting(true);

    try {
      const params: Record<string, unknown> = {
        host: host.trim(),
        port: parseInt(port) || 22,
        user: user.trim() || "root",
        password: authMode === "password" ? password : "",
      };
      if (authMode === "key") {
        if (keyInputMode === "file" && keyPath) {
          params.keyPath = keyPath;
        } else if (keyInputMode === "paste" && keyData.trim()) {
          params.keyData = keyData.trim();
        }
      }

      await invoke("check_server_installation", params);

      const creds: SshCredentials = {
        host: host.trim(),
        port: port || "22",
        user: user.trim() || "root",
        password: authMode === "password" ? password : "",
        keyPath: authMode === "key" ? keyPath : undefined,
      };
      // Store credentials in Rust backend (file-based, not localStorage)
      await invoke("save_ssh_credentials", {
        host: creds.host,
        port: creds.port,
        user: creds.user,
        password: creds.password || "",
        keyPath: creds.keyPath || null,
      });

      onConnect(creds);
    } catch (e) {
      const errStr = formatError(e);
      if (errStr.includes("HOST_KEY_CHANGED") || errStr.includes("Unknown server key")) {
        await invoke("forget_ssh_host_key", { host: host.trim(), port: parseInt(port) || 22 }).catch(() => {});
        pushSuccess(t("sshErrors.hostKeyReset", "Host key was reset. Press Connect again."));
      } else {
        pushSuccess(translateSshError(errStr, t), "error");
      }
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center py-[var(--space-7)] bg-[var(--color-bg-primary)]">
      <Card padding="lg" className="w-full max-w-[400px] rounded-[var(--radius-xl)]">
        {/* Header */}
        <div className="flex flex-col items-center mb-[var(--space-4)]">
          <div className="w-12 h-12 rounded-[var(--radius-lg)] flex items-center justify-center bg-[var(--color-bg-elevated)] mb-[var(--space-3)]">
            <Server className="w-6 h-6 text-[var(--color-accent-interactive)]" />
          </div>
          <h2 className="text-lg font-[var(--font-weight-semibold)] text-[var(--color-text-primary)] tracking-[var(--tracking-tight)]">
            {t("control.ssh_title")}
          </h2>
          <p className="text-[var(--font-size-xs)] text-[var(--color-text-muted)] mt-[var(--space-1)]">
            {t("control.ssh_description")}
          </p>
        </div>

        {/* Form fields */}
        <div className="space-y-[var(--space-4)]">
          {/* Host + Port */}
          <div className="flex gap-[var(--space-3)] items-end">
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
            <label className="block text-[var(--font-size-xs)] font-[var(--font-weight-medium)] mb-[var(--space-2)] text-[var(--color-text-secondary)]">
              {t("control.auth_method")}
            </label>
            <div className="grid grid-cols-2 gap-[var(--space-2)]">
              <Button
                variant={authMode === "password" ? "primary" : "ghost"}
                size="sm"
                onClick={() => setAuthMode("password")}
              >
                <Key className="w-3.5 h-3.5" />
                {t("control.auth_password")}
              </Button>
              <Button
                variant={authMode === "key" ? "primary" : "ghost"}
                size="sm"
                onClick={() => setAuthMode("key")}
              >
                <FileKey className="w-3.5 h-3.5" />
                {t("control.auth_key")}
              </Button>
            </div>
          </div>

          {/* Password or Key input */}
          {authMode === "password" ? (
            <PasswordInput
              label={t("labels.ssh_password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="********"
            />
          ) : (
            <div className="space-y-[var(--space-2)]">
              {/* File / Paste toggle */}
              <div className="flex gap-[var(--space-1)]">
                <Button
                  variant={keyInputMode === "file" ? "primary" : "ghost"}
                  size="sm"
                  onClick={() => setKeyInputMode("file")}
                  className="text-[var(--font-size-xs)]"
                >
                  <FileKey className="w-3 h-3" />
                  {t("control.key_from_file", "File")}
                </Button>
                <Button
                  variant={keyInputMode === "paste" ? "primary" : "ghost"}
                  size="sm"
                  onClick={() => setKeyInputMode("paste")}
                  className="text-[var(--font-size-xs)]"
                >
                  <ClipboardPaste className="w-3 h-3" />
                  {t("control.key_paste", "Paste")}
                </Button>
              </div>

              {keyInputMode === "file" ? (
                <div>
                  <div className="flex gap-[var(--space-2)]">
                    <div
                      className="flex-1 flex items-center px-[var(--space-3)] h-8 rounded-[var(--radius-lg)] text-sm truncate cursor-pointer bg-[var(--color-input-bg)] border border-[var(--color-input-border)]"
                      onClick={handleSelectKey}
                    >
                      <FileKey className="w-4 h-4 shrink-0 mr-[var(--space-2)] text-[var(--color-text-muted)]" />
                      <span className="truncate text-[var(--font-size-xs)]" style={{ color: keyPath ? "var(--color-text-primary)" : "var(--color-text-muted)" }}>
                        {keyPath ? keyPath.split(/[/\\]/).pop() : t("control.select_key")}
                      </span>
                    </div>
                    <Button variant="ghost" size="sm" onClick={handleSelectKey}>
                      {t("control.browse")}
                    </Button>
                  </div>
                  {keyPath && (
                    <p className="text-[var(--font-size-xs)] mt-[var(--space-1)] truncate text-[var(--color-text-muted)]">
                      {keyPath}
                    </p>
                  )}
                </div>
              ) : (
                <textarea
                  className="w-full rounded-[var(--radius-lg)] px-[var(--space-3)] py-[var(--space-2)] text-[var(--font-size-xs)] font-mono resize-none h-[100px] bg-[var(--color-input-bg)] border border-[var(--color-input-border)] text-[var(--color-text-primary)]"
                  value={keyData}
                  onChange={(e) => setKeyData(e.target.value)}
                  placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                  spellCheck={false}
                />
              )}
            </div>
          )}

          {/* Connect button */}
          <Button
            variant="primary"
            fullWidth
            loading={connecting}
            disabled={!isValid || connecting}
            onClick={handleConnect}
          >
            {connecting ? t("control.connecting") : t("control.connect")}
          </Button>

          {/* Security note */}
          <div className="flex items-center justify-center gap-[var(--space-1)]">
            <Lock className="w-3 h-3 text-[var(--color-text-muted)]" />
            <span className="text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
              {t("control.remember")}
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}
