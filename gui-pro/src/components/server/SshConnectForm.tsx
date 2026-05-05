import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Shield, Key, FileKey, Upload } from "lucide-react";
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
  initialHost?: string;
  initialUser?: string;
  initialPort?: string;
}

type AuthMode = "password" | "key";

const authSegments: { id: AuthMode; icon: React.ReactNode; labelKey: string; fallback: string }[] = [
  { id: "password", icon: <Key className="w-3 h-3" />,     labelKey: "control.auth_password", fallback: "Пароль" },
  { id: "key",      icon: <FileKey className="w-3 h-3" />, labelKey: "control.auth_key",      fallback: "SSH-ключ" },
];

export function SshConnectForm({ onConnect, initialHost, initialUser, initialPort }: Props) {
  const { t } = useTranslation();
  const [host, setHost] = useState(initialHost ?? "");
  const [port, setPort] = useState(initialPort ?? "22");
  const [user, setUser] = useState(initialUser ?? "root");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [keyData, setKeyData] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("password");
  const [connecting, setConnecting] = useState(false);
  // Phase 16 — auto-detect-once flag prevents repeat auto-connect attempts
  // when host text changes mid-typing or after a fallback to password.
  const [autoConnectAttempted, setAutoConnectAttempted] = useState(false);
  const handleConnectRef = useRef<() => Promise<void>>(() => Promise.resolve());
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
    if (!isValid && authMode === "password") return;
    // In key mode we may have neither keyPath nor pasted keyData when the
    // user is relying on a saved keyring entry — still allow attempt.
    setConnecting(true);

    try {
      const trimmedHost = host.trim();
      const params: Record<string, unknown> = {
        host: trimmedHost,
        port: parseInt(port) || 22,
        user: user.trim() || "root",
        password: authMode === "password" ? password : "",
      };
      if (authMode === "key") {
        if (keyPath) {
          params.keyPath = keyPath;
        } else if (keyData.trim()) {
          params.keyData = keyData.trim();
        } else {
          // Phase 16 — Resolve plaintext PEM from Windows Credential Store
          // (D-1.4). Backend reads keyring entry by host. Frontend never
          // persists the PEM and only forwards it in-memory to connect_ssh.
          try {
            const pem = await invoke<string>("load_ssh_key_for_host", { host: trimmedHost });
            if (pem) params.keyData = pem;
          } catch (loadErr) {
            const loadStr = formatError(loadErr);
            if (loadStr.includes("KEY_NOT_FOUND")) {
              pushSuccess(t("control.ssh_key_not_found"), "error");
              setAuthMode("password");
              setConnecting(false);
              return;
            }
            throw loadErr;
          }
        }
      }

      await invoke("check_server_installation", params);

      const creds: SshCredentials = {
        host: trimmedHost,
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
      // Phase 16 — D-6.1: SSH key rejected → recovery flow.
      //
      // P UAT 2026-05-04 fix (CRITICAL — user locked out): раньше fallback
      // выкидывал в password mode + clear localStorage flag. Но если user
      // уже отключил password auth на server'е → password больше не
      // работает → user locked out с no escape. Single escape hatch =
      // backup .pem file (D-2.1 forced backup при disable PW).
      //
      // New flow: остаёмся в "key" mode, очищаем keyring data (на следующий
      // attempt не пытаться снова через keyring), показываем prominent
      // file picker через i18n сообщение. User loads .pem → params.keyPath
      // → backend uses file directly (bypass keyring). После success
      // keyring можно re-populate через import flow.
      if (errStr.includes("PermissionDenied") || errStr.includes("SSH_KEY_REJECTED")) {
        // Context-aware message:
        // - keyPath set (.pem file selected via Обзор) → server reject'ит
        //   key из файла → проблема на server-side (pubkey НЕ в
        //   authorized_keys). Подсказка: серверная recovery нужна.
        // - keyData/keyring → key из хранилища не подошёл, попробовать .pem.
        const usingFileKey = !!keyPath;
        const msgKey = usingFileKey
          ? "control.ssh_key_file_rejected_server_side"
          : "control.ssh_key_rejected_recovery";
        pushSuccess(t(msgKey), "error");
        setAuthMode("key"); // stay in key mode — password может быть disabled
        setKeyData(""); // clear cached PEM from keyring (failed)
        setAutoConnectAttempted(false);
        setConnecting(false);
        // НЕ clear localStorage flag — user всё равно должен использовать key
        return;
      }
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

  // Stable ref so the mount-effect can call latest handleConnect without
  // re-firing when the closure identity changes.
  handleConnectRef.current = handleConnect;

  // Phase 16 — REQ-16-SSH-AUTO-DETECT (D-1.4 + D-6.1): on first mount with a
  // stable host, read tt_auth_method_<host> from localStorage. If "key", flip
  // auth mode and trigger handleConnect (which resolves keyData via
  // load_ssh_key_for_host). PermissionDenied path inside handleConnect clears
  // the flag and falls back to password.
  useEffect(() => {
    if (autoConnectAttempted) return;
    const trimmedHost = host.trim();
    if (!trimmedHost) return;
    const authMethod = localStorage.getItem(`tt_auth_method_${trimmedHost}`);
    if (authMethod !== "key") return;
    setAutoConnectAttempted(true);
    setAuthMode("key");
    // Defer one tick so latest state (host/port/user) is reflected.
    void Promise.resolve().then(() => handleConnectRef.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  // Phase 16 — REQ-16-SSH-IMPORT-RECOVERY (D-2.3): user picks a backup .pem,
  // backend validates + writes it to the keyring entry for this host.
  // Frontend persists the auth-method flag so future mounts auto-connect.
  const handleImportKey = async () => {
    const trimmedHost = host.trim();
    if (!trimmedHost) {
      pushSuccess(t("labels.server_address"), "error");
      return;
    }
    let selected: string | string[] | null;
    try {
      selected = await open({
        multiple: false,
        filters: [{ name: t("control.key_file_label", "Файл ключа"), extensions: ["pem", "key"] }],
      });
    } catch {
      // user cancelled
      return;
    }
    if (!selected || Array.isArray(selected)) return;
    try {
      await invoke("security_import_ssh_key", { host: trimmedHost, pemPath: selected });
      localStorage.setItem(`tt_auth_method_${trimmedHost}`, "key");
      setAuthMode("key");
      setAutoConnectAttempted(false); // allow auto-connect after import
      pushSuccess(t("control.ssh_key_imported"));
    } catch (e) {
      pushSuccess(formatError(e), "error");
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-[var(--color-bg-primary)]">
      {/* Форма — вертикально по центру */}
      <div className="w-full overflow-y-auto">
        <div className="max-w-[360px] mx-auto px-4 py-5 space-y-3.5">

          {/* Заголовок */}
          <div className="text-center pb-1">
            <h2 className="text-lg font-semibold" style={{ color: "var(--color-text-primary)" }}>
              {t("control.ssh_title")}
            </h2>
            <p className="text-sm mt-1" style={{ color: "var(--color-text-secondary)" }}>
              {t("control.ssh_description")}
            </p>
          </div>

          {/* IP + Порт */}
          <div className="flex gap-2.5 items-end">
            <div className="flex-1">
              <Input
                label={t("labels.server_address")}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="123.45.67.89"
                autoFocus
              />
            </div>
            <div className="w-[80px]">
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
            placeholder="root"
          />

          {/* Способ авторизации — 2 сегмента */}
          <div>
            <label className="block text-sm font-medium mb-1.5 text-[var(--color-text-secondary)]">
              {t("control.auth_method")}
            </label>
            <div className="flex rounded-[var(--radius-md)] border border-[var(--color-border)] overflow-hidden">
              {authSegments.map((seg) => (
                <button
                  key={seg.id}
                  type="button"
                  onClick={() => setAuthMode(seg.id)}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium transition-colors",
                    "border-r border-[var(--color-border)] last:border-r-0",
                    authMode === seg.id
                      ? "bg-[var(--color-accent-interactive)] text-white"
                      : "bg-[var(--color-input-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]"
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
              label={t("labels.password")}
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
                <label className="block text-sm font-medium mb-1.5 text-[var(--color-text-secondary)]">
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
                  <p className="text-xs mt-1 truncate text-[var(--color-text-muted)]">
                    {keyPath}
                  </p>
                )}
              </div>

              {/* Phase 16 — Загрузить .pem из backup в Windows Credential Store
                  (D-2.3 import recovery). При успехе SshConnectForm запоминает
                  tt_auth_method_<host>=key, чтобы следующий mount подключился
                  по ключу автоматически. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleImportKey}
                icon={<Upload className="w-3.5 h-3.5" />}
                fullWidth
              >
                {t("control.ssh_key_load_button")}
              </Button>

              {/* Разделитель */}
              <Separator label={t("control.or_separator", "или")} />

              {/* Вставить ключ */}
              <div>
                <label className="block text-sm font-medium mb-1.5 text-[var(--color-text-secondary)]">
                  {t("control.key_paste_label", "Вставить ключ")}
                </label>
                <textarea
                  className="w-full rounded-[var(--radius-md)] px-2.5 py-2 text-xs font-mono resize-none h-[80px] bg-[var(--color-input-bg)] border border-[var(--color-input-border)] text-[var(--color-text-primary)] focus:border-[var(--color-accent-interactive)] outline-none focus-visible:shadow-[var(--focus-ring)] transition-colors"
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
          <div className="flex items-center justify-center gap-1.5 pt-1">
            <Shield className="w-3 h-3 text-[var(--color-text-muted)]" />
            <span className="text-xs text-[var(--color-text-muted)]">
              {t("control.remember")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
