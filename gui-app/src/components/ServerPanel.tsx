import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  Server,
  RefreshCw,
  Power,
  PowerOff,
  RotateCcw,
  Users,
  UserPlus,
  Trash2,
  Download,
  Shield,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  Eye,
  EyeOff,
  ArrowUpCircle,
  ScrollText,
  ChevronDown,
  ChevronUp,
  Copy,
  HelpCircle,
} from "lucide-react";
import { Tooltip } from "../shared/ui/Tooltip";

interface ServerPanelProps {
  host: string;
  port: string;
  sshUser: string;
  sshPassword: string;
  onSwitchToSetup: () => void;
  onClearConfig: () => void;
  onConfigExported: (configPath: string) => void;
}

interface ServerInfo {
  installed: boolean;
  version: string;
  serviceActive: boolean;
  users: string[];
}

// ─── Small Section Header ────────────────────────
function SectionHeader({ title, tooltip, icon }: { title: string; tooltip?: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      {icon && <span style={{ color: "var(--color-accent-400)" }}>{icon}</span>}
      <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>
        {title}
      </h3>
      {tooltip && (
        <Tooltip text={tooltip}>
          <HelpCircle className="w-3 h-3 cursor-help" style={{ color: "var(--color-text-muted)" }} />
        </Tooltip>
      )}
    </div>
  );
}

// ─── Action Button ──────────────────────────────
function ActionButton({
  onClick,
  icon,
  label,
  variant = "default",
  loading = false,
  disabled = false,
  confirm,
  small = false,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  variant?: "default" | "danger" | "success";
  loading?: boolean;
  disabled?: boolean;
  confirm?: string;
  small?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  const handleClick = () => {
    if (confirm && !confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    onClick();
  };

  const colors = {
    default: { bg: "var(--color-bg-hover)", text: "var(--color-text-primary)", border: "var(--color-border)" },
    danger: { bg: "rgba(239, 68, 68, 0.08)", text: "var(--color-danger-500)", border: "rgba(239, 68, 68, 0.2)" },
    success: { bg: "rgba(16, 185, 129, 0.08)", text: "var(--color-success-500)", border: "rgba(16, 185, 129, 0.2)" },
  };
  const c = colors[variant];

  return (
    <button
      onClick={handleClick}
      disabled={disabled || loading}
      className={`flex items-center justify-center gap-1.5 rounded-[var(--radius-lg)] font-medium transition-all
                  active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed
                  ${small ? "px-2.5 py-1.5 text-[11px]" : "px-3 py-2 text-xs"}`}
      style={{ backgroundColor: c.bg, color: c.text, border: `1px solid ${c.border}` }}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      {confirming ? "Подтвердить?" : label}
    </button>
  );
}

export function ServerPanel({
  host,
  port,
  sshUser,
  sshPassword,
  onSwitchToSetup,
  onClearConfig,
  onConfigExported,
}: ServerPanelProps) {
  const { t } = useTranslation();

  // ─── State ───
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ type: "ok" | "error"; message: string } | null>(null);

  // Users
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showNewPw, setShowNewPw] = useState(false);
  const [exportingUser, setExportingUser] = useState<string | null>(null);

  // Versions
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [showVersions, setShowVersions] = useState(false);

  // Logs
  const [serverLogs, setServerLogs] = useState("");
  const [showLogs, setShowLogs] = useState(false);

  // ─── Load server info ───
  const loadServerInfo = useCallback(async () => {
    if (!host || !sshPassword) return;
    setLoading(true);
    setError("");
    try {
      const info = await invoke<ServerInfo>("check_server_installation", {
        host, port: parseInt(port), user: sshUser, password: sshPassword,
      });
      setServerInfo(info);
    } catch (e) {
      setError(String(e));
      setServerInfo(null);
    } finally {
      setLoading(false);
    }
  }, [host, port, sshUser, sshPassword]);

  useEffect(() => { loadServerInfo(); }, [loadServerInfo]);

  // ─── Action helper ───
  const runAction = useCallback(async (name: string, fn: () => Promise<unknown>) => {
    setActionLoading(name);
    setActionResult(null);
    try {
      await fn();
      setActionResult({ type: "ok", message: `${name}: успешно` });
      // Refresh server info after action
      setTimeout(() => loadServerInfo(), 1500);
    } catch (e) {
      setActionResult({ type: "error", message: String(e) });
    } finally {
      setActionLoading(name);
      setTimeout(() => setActionLoading(null), 100);
    }
  }, [loadServerInfo]);

  // ─── Load available versions ───
  useEffect(() => {
    invoke<string[]>("server_get_available_versions")
      .then((versions) => {
        setAvailableVersions(versions);
        if (versions.length > 0) setSelectedVersion(versions[0]);
      })
      .catch(() => {});
  }, []);

  // ─── Render: Loading ───
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-3" style={{ color: "var(--color-text-muted)" }}>
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Проверка сервера...</span>
        </div>
      </div>
    );
  }

  // ─── Render: Error / No connection ───
  if (error || !serverInfo) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: "rgba(239, 68, 68, 0.1)" }}>
            <XCircle className="w-6 h-6" style={{ color: "var(--color-danger-500)" }} />
          </div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-text-primary)" }}>
            Не удалось подключиться к серверу
          </h2>
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {error || "Проверьте SSH-данные и доступность сервера"}
          </p>
          <div className="flex gap-2 justify-center">
            <ActionButton onClick={loadServerInfo} icon={<RefreshCw className="w-3.5 h-3.5" />} label="Повторить" />
            <ActionButton onClick={onSwitchToSetup} icon={<Server className="w-3.5 h-3.5" />} label="Настроить SSH" />
          </div>
        </div>
      </div>
    );
  }

  // ─── Render: Not installed ───
  if (!serverInfo.installed) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: "rgba(245, 158, 11, 0.1)" }}>
            <AlertTriangle className="w-6 h-6" style={{ color: "var(--color-warning-500)" }} />
          </div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-text-primary)" }}>
            TrustTunnel не установлен
          </h2>
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            Сервер {host} доступен, но TrustTunnel не найден.
          </p>
          <ActionButton
            onClick={onSwitchToSetup}
            icon={<Download className="w-4 h-4" />}
            label="Установить TrustTunnel"
            variant="success"
          />
        </div>
      </div>
    );
  }

  // ─── Render: Server Management Panel ───
  return (
    <div className="flex-1 overflow-y-auto py-3 space-y-4">

      {/* Action result banner */}
      {actionResult && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-lg)] text-xs"
          style={{
            backgroundColor: actionResult.type === "ok" ? "rgba(16, 185, 129, 0.08)" : "rgba(239, 68, 68, 0.08)",
            border: `1px solid ${actionResult.type === "ok" ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)"}`,
            color: actionResult.type === "ok" ? "var(--color-success-500)" : "var(--color-danger-500)",
          }}
        >
          {actionResult.type === "ok" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
          <span className="flex-1">{actionResult.message}</span>
          <button onClick={() => setActionResult(null)} className="opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* ── Section 1: Server Status ── */}
      <div className="rounded-[var(--radius-xl)] p-4" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
        <SectionHeader
          title="Статус сервера"
          icon={<Server className="w-3.5 h-3.5" />}
          tooltip="Состояние TrustTunnel на удалённом сервере. Отсюда можно перезагрузить сервис или весь сервер."
        />

        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            {/* Status indicator */}
            <div
              className="w-2.5 h-2.5 rounded-full"
              style={{
                backgroundColor: serverInfo.serviceActive ? "var(--color-success-500)" : "var(--color-danger-500)",
                boxShadow: serverInfo.serviceActive ? "0 0 8px rgba(16, 185, 129, 0.5)" : "0 0 8px rgba(239, 68, 68, 0.3)",
              }}
            />
            <div>
              <span className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
                {serverInfo.serviceActive ? "Работает" : "Остановлен"}
              </span>
              <span className="text-[11px] ml-2" style={{ color: "var(--color-text-muted)" }}>
                {host}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] px-2 py-0.5 rounded-full" style={{
              backgroundColor: "rgba(99, 102, 241, 0.1)", color: "var(--color-accent-500)",
            }}>
              v{serverInfo.version || "?"}
            </span>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex flex-wrap gap-2">
          {serverInfo.serviceActive ? (
            <>
              <ActionButton
                onClick={() => runAction("Перезапуск", () => invoke("server_restart_service", { host, port: parseInt(port), user: sshUser, password: sshPassword }))}
                icon={<RefreshCw className="w-3.5 h-3.5" />}
                label="Перезапустить"
                loading={actionLoading === "Перезапуск"}
                small
              />
              <ActionButton
                onClick={() => runAction("Остановка", () => invoke("server_stop_service", { host, port: parseInt(port), user: sshUser, password: sshPassword }))}
                icon={<PowerOff className="w-3.5 h-3.5" />}
                label="Остановить"
                variant="danger"
                loading={actionLoading === "Остановка"}
                confirm="Остановить сервис?"
                small
              />
            </>
          ) : (
            <ActionButton
              onClick={() => runAction("Запуск", () => invoke("server_start_service", { host, port: parseInt(port), user: sshUser, password: sshPassword }))}
              icon={<Power className="w-3.5 h-3.5" />}
              label="Запустить"
              variant="success"
              loading={actionLoading === "Запуск"}
              small
            />
          )}
          <ActionButton
            onClick={() => runAction("Перезагрузка сервера", () => invoke("server_reboot", { host, port: parseInt(port), user: sshUser, password: sshPassword }))}
            icon={<RotateCcw className="w-3.5 h-3.5" />}
            label="Reboot сервер"
            variant="danger"
            loading={actionLoading === "Перезагрузка сервера"}
            confirm="Перезагрузить весь сервер?"
            small
          />
          <ActionButton
            onClick={loadServerInfo}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            label="Обновить статус"
            loading={loading}
            small
          />
        </div>
      </div>

      {/* ── Section 2: Users ── */}
      <div className="rounded-[var(--radius-xl)] p-4" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
        <SectionHeader
          title={`Пользователи (${serverInfo.users.length})`}
          icon={<Users className="w-3.5 h-3.5" />}
          tooltip="Учётные записи VPN-клиентов. Каждое устройство должно подключаться под своим пользователем. Можно экспортировать конфиг для передачи другим."
        />

        {/* User list */}
        <div className="space-y-1.5 mb-3">
          {serverInfo.users.map((user) => (
            <div
              key={user}
              className="flex items-center justify-between px-3 py-2 rounded-[var(--radius-md)]"
              style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
            >
              <div className="flex items-center gap-2">
                <Shield className="w-3.5 h-3.5" style={{ color: "var(--color-accent-400)" }} />
                <span className="text-xs font-medium" style={{ color: "var(--color-text-primary)" }}>{user}</span>
              </div>
              <div className="flex items-center gap-1">
                <Tooltip text="Экспортировать .toml конфиг для этого пользователя">
                  <button
                    onClick={async () => {
                      setExportingUser(user);
                      try {
                        const path = await invoke<string>("fetch_server_config", {
                          host, port: parseInt(port), user: sshUser, password: sshPassword, clientName: user,
                        });
                        onConfigExported(path);
                      } catch (e) {
                        setActionResult({ type: "error", message: `Экспорт конфига: ${e}` });
                      } finally {
                        setExportingUser(null);
                      }
                    }}
                    disabled={exportingUser === user}
                    className="p-1 rounded transition-colors"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {exportingUser === user ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                  </button>
                </Tooltip>
                <Tooltip text="Удалить пользователя с сервера">
                  <button
                    onClick={() => {
                      if (!confirm(`Удалить пользователя "${user}"?`)) return;
                      runAction(`Удаление ${user}`, () =>
                        invoke("server_remove_user", {
                          host, port: parseInt(port), user: sshUser, password: sshPassword, vpnUsername: user,
                        })
                      );
                    }}
                    className="p-1 rounded transition-colors"
                    style={{ color: "var(--color-danger-400)" }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </Tooltip>
              </div>
            </div>
          ))}
          {serverInfo.users.length === 0 && (
            <p className="text-xs text-center py-2" style={{ color: "var(--color-text-muted)" }}>
              Нет пользователей
            </p>
          )}
        </div>

        {/* Add user form */}
        <div className="flex gap-1.5">
          <input
            type="text"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder="Имя пользователя"
            className="flex-1 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[11px] outline-none"
            style={{
              backgroundColor: "var(--color-input-bg)", border: "1px solid var(--color-input-border)",
              color: "var(--color-text-primary)",
            }}
          />
          <div className="relative flex-1">
            <input
              type={showNewPw ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Пароль"
              className="w-full rounded-[var(--radius-md)] px-2.5 py-1.5 pr-7 text-[11px] outline-none"
              style={{
                backgroundColor: "var(--color-input-bg)", border: "1px solid var(--color-input-border)",
                color: "var(--color-text-primary)",
              }}
            />
            <button onClick={() => setShowNewPw(!showNewPw)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2" style={{ color: "var(--color-text-muted)" }}>
              {showNewPw ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            </button>
          </div>
          <ActionButton
            onClick={() => {
              if (!newUsername.trim() || !newPassword.trim()) return;
              runAction(`Добавление ${newUsername}`, async () => {
                await invoke("add_server_user", {
                  host, port: parseInt(port), user: sshUser, password: sshPassword,
                  vpnUsername: newUsername.trim(), vpnPassword: newPassword.trim(),
                });
                setNewUsername("");
                setNewPassword("");
              });
            }}
            icon={<UserPlus className="w-3.5 h-3.5" />}
            label="Добавить"
            variant="success"
            loading={actionLoading?.startsWith("Добавление")}
            disabled={!newUsername.trim() || !newPassword.trim()}
            small
          />
        </div>
      </div>

      {/* ── Section 3: Version & Updates ── */}
      <div className="rounded-[var(--radius-xl)] p-4" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
        <SectionHeader
          title="Версия и обновления"
          icon={<ArrowUpCircle className="w-3.5 h-3.5" />}
          tooltip="Управление версией TrustTunnel на сервере. Можно обновить до последней версии или установить конкретную."
        />

        <div className="flex items-center gap-3 mb-3">
          <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
            Текущая: <strong style={{ color: "var(--color-text-primary)" }}>v{serverInfo.version || "?"}</strong>
          </span>
          {availableVersions.length > 0 && serverInfo.version !== availableVersions[0] && (
            <span className="text-[10px] px-2 py-0.5 rounded-full"
              style={{ backgroundColor: "rgba(16, 185, 129, 0.1)", color: "var(--color-success-500)" }}>
              Доступна v{availableVersions[0]}
            </span>
          )}
        </div>

        <div className="flex gap-2">
          {availableVersions.length > 0 && serverInfo.version !== availableVersions[0] && (
            <ActionButton
              onClick={() => runAction("Обновление", () =>
                invoke("server_upgrade", {
                  host, port: parseInt(port), user: sshUser, password: sshPassword,
                  version: availableVersions[0],
                })
              )}
              icon={<ArrowUpCircle className="w-3.5 h-3.5" />}
              label={`Обновить до v${availableVersions[0]}`}
              variant="success"
              loading={actionLoading === "Обновление"}
              small
            />
          )}

          <button
            onClick={() => setShowVersions(!showVersions)}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-[var(--radius-lg)] text-[11px] font-medium transition-all"
            style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)" }}
          >
            Все версии
            {showVersions ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>

        {showVersions && availableVersions.length > 0 && (
          <div className="mt-2 flex gap-2">
            <select
              value={selectedVersion}
              onChange={(e) => setSelectedVersion(e.target.value)}
              className="flex-1 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[11px] outline-none appearance-none"
              style={{
                backgroundColor: "var(--color-input-bg)", border: "1px solid var(--color-input-border)",
                color: "var(--color-text-primary)",
              }}
            >
              {availableVersions.map((v) => (
                <option key={v} value={v}>v{v} {v === serverInfo.version ? "(текущая)" : ""}</option>
              ))}
            </select>
            <ActionButton
              onClick={() => runAction("Установка версии", () =>
                invoke("server_upgrade", {
                  host, port: parseInt(port), user: sshUser, password: sshPassword,
                  version: selectedVersion,
                })
              )}
              icon={<Download className="w-3.5 h-3.5" />}
              label="Установить"
              loading={actionLoading === "Установка версии"}
              disabled={selectedVersion === serverInfo.version}
              small
            />
          </div>
        )}
      </div>

      {/* ── Section 4: Server Logs ── */}
      <div className="rounded-[var(--radius-xl)] p-4" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
        <SectionHeader
          title="Логи сервера"
          icon={<ScrollText className="w-3.5 h-3.5" />}
          tooltip="Последние 100 строк логов TrustTunnel на сервере. Полезно для диагностики проблем с подключением."
        />

        <div className="flex gap-2">
          <ActionButton
            onClick={async () => {
              setShowLogs(true);
              try {
                const logs = await invoke<string>("server_get_logs", {
                  host, port: parseInt(port), user: sshUser, password: sshPassword,
                });
                setServerLogs(logs);
              } catch (e) {
                setServerLogs(`Ошибка: ${e}`);
              }
            }}
            icon={<ScrollText className="w-3.5 h-3.5" />}
            label={showLogs ? "Обновить логи" : "Загрузить логи"}
            small
          />
          {showLogs && serverLogs && (
            <ActionButton
              onClick={() => { navigator.clipboard.writeText(serverLogs); }}
              icon={<Copy className="w-3.5 h-3.5" />}
              label="Копировать"
              small
            />
          )}
        </div>

        {showLogs && (
          <pre
            className="mt-2 p-3 rounded-[var(--radius-md)] text-[10px] leading-relaxed overflow-auto max-h-48 whitespace-pre-wrap font-mono"
            style={{
              backgroundColor: "var(--color-bg-primary)", border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            {serverLogs || "Загрузка..."}
          </pre>
        )}
      </div>

      {/* ── Section 5: Danger Zone ── */}
      <div className="rounded-[var(--radius-xl)] p-4" style={{ border: "1px solid rgba(239, 68, 68, 0.15)" }}>
        <SectionHeader
          title="Опасная зона"
          icon={<AlertTriangle className="w-3.5 h-3.5" style={{ color: "var(--color-danger-400)" }} />}
          tooltip="Действия, которые могут привести к потере данных или разрыву VPN-подключения. Будьте осторожны."
        />
        <div className="flex flex-wrap gap-2">
          <ActionButton
            onClick={() => {
              runAction("Переустановка", async () => {
                onClearConfig();
                onSwitchToSetup();
              });
            }}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            label="Переустановить"
            variant="danger"
            confirm="Переустановить TrustTunnel?"
            small
          />
          <ActionButton
            onClick={() => {
              runAction("Удаление", async () => {
                await invoke("uninstall_server", {
                  host, port: parseInt(port), user: sshUser, password: sshPassword,
                });
                onClearConfig();
                onSwitchToSetup();
              });
            }}
            icon={<Trash2 className="w-3.5 h-3.5" />}
            label="Удалить TrustTunnel"
            variant="danger"
            loading={actionLoading === "Удаление"}
            confirm="Полностью удалить TrustTunnel с сервера?"
            small
          />
        </div>
      </div>
    </div>
  );
}
