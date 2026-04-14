import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Lock, Key, FileKey } from "lucide-react";
import { Input } from "../../shared/ui/Input";
import { PasswordInput } from "../../shared/ui/PasswordInput";
import { Button } from "../../shared/ui/Button";
import { cn } from "../../shared/lib/cn";
import { Separator } from "../../shared/ui/Separator";
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

const authSegments: { id: AuthMode; icon: React.ReactNode; labelKey: string; fallback: string }[] = [
  { id: "password", icon: <Key className="w-3 h-3" />,     labelKey: "control.auth_password", fallback: "Пароль" },
  { id: "key",      icon: <FileKey className="w-3 h-3" />, labelKey: "control.auth_key",      fallback: "SSH-ключ" },
];

export function SshConnectForm({ onConnect }: Props) {
  const { t } = useTranslation();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [keyData, setKeyData] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("password");
  const [connecting, setConnecting] = useState(false);
  const pushSuccess = useSnackBar();

  const handleSelectKey = async () => {
    try {
      const selected = await open({
        title: t("control.select_key_title"),
        filters: [{ name: "All Files", extensions: ["*"] }],
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
      : keyPath.trim() || keyData.trim());

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
        if (keyPath) {
          params.keyPath = keyPath;
        } else if (keyData.trim()) {
          params.keyData = keyData.trim();
        }
      }

      await invoke("check_server_installation", params);

      const creds: SshCredentials = {
        host: host.trim(),
        port: port || "22",
        user: user.trim() || "root",
        password: authMode === "password" ? password : "",
        keyPath: authMode === "key" ? keyPath || undefined : undefined,
      };
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
    <div className="flex-1 flex flex-col bg-[var(--color-bg-primary)]">
      {/* Заголовок панели */}
      <div className="h-[40px] flex items-center px-4 border-b border-[var(--color-border)] shrink-0">
        <h2 className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
          {t("control.ssh_title")}
        </h2>
      </div>

      {/* Форма */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[360px] mx-auto px-4 py-5 space-y-3.5">
          <p className="text-xs text-[var(--color-text-muted)]">
            {t("control.ssh_description")}
          </p>

          {/* IP + Порт */}
          <div className="flex gap-2.5 items-end">
            <div className="flex-1">
              <Input
                label={t("labels.server_ip")}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="123.45.67.89"
              />
            </div>
            <div className="w-[72px]">
              <Input
                label={t("labels.port")}
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                placeholder="22"
              />
            </div>
          </div>

          {/* Имя пользователя */}
          <Input
            label={t("labels.username")}
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder={t("control.username_placeholder", "Введите имя пользователя")}
          />

          {/* Способ авторизации — 2 сегмента */}
          <div>
            <label className="block text-sm font-[var(--font-weight-semibold)] mb-1.5 text-[var(--color-text-secondary)]">
              {t("control.auth_method")}
            </label>
            <div className="flex rounded-[var(--radius-md)] border border-[var(--color-border)] overflow-hidden">
              {authSegments.map((seg) => (
                <button
                  key={seg.id}
                  type="button"
                  onClick={() => setAuthMode(seg.id)}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-medium transition-colors",
                    "border-r border-[var(--color-border)] last:border-r-0",
                    authMode === seg.id
                      ? "bg-[var(--color-accent-interactive)] text-white"
                      : "bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-elevated)]"
                  )}
                >
                  {seg.icon}
                  {t(seg.labelKey, seg.fallback)}
                </button>
              ))}
            </div>
          </div>

          {/* Пароль */}
          {authMode === "password" && (
            <PasswordInput
              label={t("labels.ssh_password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("control.password_placeholder", "Введите пароль")}
            />
          )}

          {/* SSH-ключ: файл + сепаратор "или" + вставка */}
          {authMode === "key" && (
            <div className="space-y-3">
              {/* Файл ключа */}
              <div>
                <label className="block text-sm font-[var(--font-weight-semibold)] mb-1.5 text-[var(--color-text-secondary)]">
                  {t("control.key_file_label", "Файл ключа")}
                </label>
                <div className="flex gap-1.5">
                  <div
                    className="flex-1 flex items-center px-2.5 h-8 rounded-[var(--radius-md)] text-xs truncate cursor-pointer bg-[var(--color-input-bg)] border border-[var(--color-input-border)] hover:border-[var(--color-accent-interactive)] transition-colors"
                    onClick={handleSelectKey}
                  >
                    <FileKey className="w-3.5 h-3.5 shrink-0 mr-2 text-[var(--color-text-muted)]" />
                    <span className="truncate text-xs" style={{ color: keyPath ? "var(--color-text-primary)" : "var(--color-text-muted)" }}>
                      {keyPath ? keyPath.split(/[/\\]/).pop() : t("control.select_key")}
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={handleSelectKey}>
                    {t("control.browse")}
                  </Button>
                </div>
                {keyPath && (
                  <p className="text-[10px] mt-1 truncate text-[var(--color-text-muted)]">
                    {keyPath}
                  </p>
                )}
              </div>

              {/* Разделитель */}
              <Separator label={t("control.or_separator", "или")} />

              {/* Вставить ключ */}
              <div>
                <label className="block text-sm font-[var(--font-weight-semibold)] mb-1.5 text-[var(--color-text-secondary)]">
                  {t("control.key_paste_label", "Вставить ключ")}
                </label>
                <textarea
                  className="w-full rounded-[var(--radius-md)] px-2.5 py-2 text-xs font-mono resize-none h-[80px] bg-[var(--color-input-bg)] border border-[var(--color-input-border)] text-[var(--color-text-primary)] focus:border-[var(--color-accent-interactive)] outline-none transition-colors"
                  value={keyData}
                  onChange={(e) => setKeyData(e.target.value)}
                  placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                  spellCheck={false}
                />
              </div>
            </div>
          )}

          {/* Кнопка подключения */}
          <Button
            variant="primary"
            fullWidth
            loading={connecting}
            disabled={!isValid || connecting}
            onClick={handleConnect}
          >
            {connecting ? t("control.connecting") : t("control.connect")}
          </Button>

          {/* Примечание */}
          <div className="flex items-center justify-center gap-1 pt-1">
            <Lock className="w-3 h-3 text-[var(--color-text-muted)]" />
            <span className="text-[10px] text-[var(--color-text-muted)]">
              {t("control.remember")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
