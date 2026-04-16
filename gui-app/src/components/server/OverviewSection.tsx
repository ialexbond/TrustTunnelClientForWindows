import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  HeartPulse,
  Activity,
  Zap,
  Users,
  Network,
  Globe,
  Clock,
  Package,
  Shield,
  Gauge,
  RefreshCw,
  ChevronRight,
} from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { ProgressBar } from "../../shared/ui/ProgressBar";
import { Skeleton } from "../../shared/ui/Skeleton";
import { EcgSvg, ecgHeartbeat, ecgFlatline } from "../../shared/ui/EcgSvg";
import type { ServerState } from "./useServerState";

/* ═══════════════════════════════════════════════════════
   OverviewSection — 10 карточек обзора сервера
   flex-wrap layout, 3 ряда при ≥1000px
   ═══════════════════════════════════════════════════════ */

interface Props {
  state: ServerState;
}

/* ── Shared styles ── */
const muted: React.CSSProperties = { color: "var(--color-text-muted)" };
const primary: React.CSSProperties = { color: "var(--color-text-primary)" };
const accent: React.CSSProperties = { color: "var(--color-accent-interactive)" };
const bigNum: React.CSSProperties = { fontSize: "2rem", fontWeight: 600, lineHeight: 1, color: "var(--color-text-primary)" };
const danger: React.CSSProperties = { color: "var(--color-danger-500)" };

/* ── Title ── */
function Title({ icon, text, onRefresh, refreshing, clickable }: {
  icon: React.ReactNode;
  text: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  clickable?: boolean;
}) {
  return (
    <div className="flex items-center justify-between mb-3" style={{ height: 32 }}>
      <div className="flex items-center gap-2 h-full whitespace-nowrap">
        <span className="flex items-center justify-center w-5 h-5 shrink-0" style={accent}>{icon}</span>
        <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>{text}</span>
      </div>
      <div className="flex items-center h-full shrink-0 ml-2">
        {onRefresh && (
          <button
            className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] hover:bg-[var(--color-bg-hover)] transition-colors"
            aria-label="Обновить"
            style={muted}
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <RefreshCw className="w-4 h-4" />}
          </button>
        )}
        {clickable && (
          <span className="flex items-center justify-center w-8 h-8">
            <ChevronRight className="w-5 h-5" style={muted} />
          </span>
        )}
      </div>
    </div>
  );
}

export function OverviewSection({ state }: Props) {
  const { t } = useTranslation();
  const { serverInfo, sshParams, loadServerInfo, rebooting, setRebooting, setServerInfo } = state;

  const [ping, setPing] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rebootCountdown, setRebootCountdown] = useState(0);
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Initial ping ──
  useEffect(() => {
    if (!serverInfo?.serviceActive) { setPing(null); return; }
    invoke<number>("ping_endpoint", { host: state.host, port: 443 })
      .then((ms) => setPing(ms))
      .catch(() => setPing(-1));
  }, [state.host, serverInfo?.serviceActive]);

  // ── Background health check: ping every 30s ──
  useEffect(() => {
    if (!serverInfo?.serviceActive || rebooting) return;
    healthPollRef.current = setInterval(() => {
      invoke<number>("ping_endpoint", { host: state.host, port: 443 })
        .then((ms) => setPing(ms))
        .catch(() => setPing(-1));
    }, 30000);
    return () => { if (healthPollRef.current) clearInterval(healthPollRef.current); };
  }, [state.host, serverInfo?.serviceActive, rebooting]);

  // ── Reboot polling ──
  useEffect(() => {
    if (!rebooting) return;
    let elapsed = 0;
    const interval = setInterval(async () => {
      elapsed += 10;
      setRebootCountdown(elapsed);
      try {
        const info = await invoke<{ installed: boolean; version: string; serviceActive: boolean; users: string[] }>(
          "check_server_installation", sshParams
        );
        if (info) {
          setRebooting(false);
          setRebootCountdown(0);
          setServerInfo(info);
          state.pushSuccess(t("server.actions.success_reboot_done"));
          invoke<number>("ping_endpoint", { host: state.host, port: 443 })
            .then((ms) => setPing(ms))
            .catch(() => setPing(-1));
        }
      } catch {
        if (elapsed >= 120) {
          setRebooting(false);
          setRebootCountdown(0);
          invoke("clear_ssh_credentials").catch(() => {});
          localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());
        }
      }
    }, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebooting]);

  const refreshPing = useCallback(() => {
    invoke<number>("ping_endpoint", { host: state.host, port: 443 })
      .then((ms) => setPing(ms))
      .catch(() => setPing(-1));
  }, [state.host]);

  const handleSoftRefresh = async () => {
    setRefreshing(true);
    await loadServerInfo(true);
    refreshPing();
    setRefreshing(false);
  };

  // ── Skeleton: пока нет данных ──
  if (!serverInfo) {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, width: "100%" }}>
        {[
          { icon: <HeartPulse className="w-5 h-5" />, text: "Статус", flex: "1 1 220px", maxWidth: "260px", h: 56 },
          { icon: <Activity className="w-5 h-5" />, text: "Ping", flex: "1 1 140px", maxWidth: "180px", h: 48 },
          { icon: <Zap className="w-5 h-5" />, text: "Скорость", flex: "2 1 340px", h: 48 },
          { icon: <Users className="w-5 h-5" />, text: "Пользователей", flex: "1 1 180px", h: 48 },
          { icon: <Network className="w-5 h-5" />, text: "IP-адрес", flex: "1 1 240px", h: 48 },
          { icon: <Globe className="w-5 h-5" />, text: "Страна", flex: "1 1 180px", h: 36 },
          { icon: <Clock className="w-5 h-5" />, text: "Uptime", flex: "1 1 160px", h: 48 },
          { icon: <Package className="w-5 h-5" />, text: "Версия", flex: "1 1 220px", h: 48 },
        ].map((c) => (
          <Card key={c.text} padding="md" style={{ flex: c.flex, maxWidth: c.maxWidth }}>
            <Title icon={c.icon} text={c.text} />
            <div className="flex items-center justify-center py-2" style={{ minHeight: c.h }}>
              <Skeleton variant="line" width={100} height={32} />
            </div>
          </Card>
        ))}
        <Card padding="md" style={{ flex: "1 1 340px" }}>
          <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" />
          <div className="grid grid-cols-2 gap-2 mt-1">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <Skeleton variant="line" width={60} height={14} className="mb-1" />
                <Skeleton variant="line" width={50} height={14} />
              </div>
            ))}
          </div>
        </Card>
        <Card padding="md" style={{ flex: "2 1 400px" }}>
          <Title icon={<Gauge className="w-5 h-5" />} text="Нагрузка" />
          <div className="space-y-2.5 mt-1">
            {[1, 2].map(i => (
              <div key={i}>
                <div className="flex items-center justify-between mb-1">
                  <Skeleton variant="line" width={30} height={20} />
                  <Skeleton variant="line" width={60} height={20} />
                </div>
                <Skeleton variant="line" width="100%" height={6} />
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  // ── Computed values ──
  const isRunning = serverInfo.serviceActive;
  const userCount = serverInfo.users?.length ?? 0;
  const version = serverInfo.version || "—";

  const pingColor = (() => {
    if (ping === null || ping <= 0) return "var(--color-text-muted)";
    if (ping < 100) return "var(--color-success-500)";
    if (ping < 300) return "var(--color-warning-500)";
    return "var(--color-danger-500)";
  })();

  const hasTls = !!state.certRaw;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, width: "100%" }}>

      {/* ── Row 1: Статус | Ping | Скорость | Пользователей ── */}

      {/* Статус — ECG */}
      <Card padding="md" style={{ flex: "1 1 220px", maxWidth: 260 }}>
        <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" onRefresh={handleSoftRefresh} refreshing={refreshing} />
        {rebooting ? (
          <div className="flex flex-col items-center justify-center gap-1.5 py-1">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--color-warning-500)" }} />
            <span className="text-sm" style={{ color: "var(--color-warning-500)" }}>
              Перезагрузка{rebootCountdown > 0 ? ` ${rebootCountdown}s` : "..."}
            </span>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-1.5 py-1">
            <EcgSvg
              color={isRunning ? "var(--color-success-500)" : "var(--color-danger-500)"}
              path={isRunning ? ecgHeartbeat : ecgFlatline}
              anim={isRunning ? "ecg-live" : "ecg-dead"}
            />
            <span className="text-sm" style={isRunning ? muted : danger}>
              {isRunning ? "Работает" : "Остановлен"}
            </span>
          </div>
        )}
      </Card>

      {/* Ping */}
      <Card padding="md" style={{ flex: "1 1 140px", maxWidth: 180 }}>
        <Title icon={<Activity className="w-5 h-5" />} text="Ping" onRefresh={refreshPing} />
        <div className="flex items-baseline justify-center gap-1 py-2">
          {ping !== null && ping > 0 ? (
            <>
              <span style={{ ...bigNum, color: pingColor }}>{ping}</span>
              <span className="text-sm" style={muted}>ms</span>
            </>
          ) : (
            <span style={{ ...bigNum, ...muted }}>—</span>
          )}
        </div>
      </Card>

      {/* Скорость — заглушка */}
      <Card padding="md" style={{ flex: "2 1 340px" }}>
        <Title icon={<Zap className="w-5 h-5" />} text="Скорость" />
        <div className="flex items-center justify-center py-2" style={{ minHeight: 48 }}>
          <span className="text-sm" style={muted}>Не измерялась</span>
        </div>
      </Card>

      {/* Пользователей */}
      <Card padding="md" style={{ flex: "1 1 180px" }}>
        <Title icon={<Users className="w-5 h-5" />} text="Пользователей" clickable />
        <div className="flex items-center justify-center py-2">
          <span style={userCount > 0 ? bigNum : { ...bigNum, ...muted }}>{userCount}</span>
        </div>
      </Card>

      {/* ── Row 2: IP | Страна | Uptime | Версия ── */}

      {/* IP */}
      <Card padding="md" style={{ flex: "1 1 240px" }}>
        <Title icon={<Network className="w-5 h-5" />} text="IP-адрес" />
        <div className="flex items-center justify-center py-2">
          <span style={bigNum}>{state.host || "—"}</span>
        </div>
      </Card>

      {/* Страна — заглушка */}
      <Card padding="md" style={{ flex: "1 1 180px" }}>
        <Title icon={<Globe className="w-5 h-5" />} text="Страна" />
        <div className="flex items-center justify-center py-2">
          <span className="text-xl font-[var(--font-weight-semibold)]" style={muted}>—</span>
        </div>
      </Card>

      {/* Uptime — заглушка */}
      <Card padding="md" style={{ flex: "1 1 160px" }}>
        <Title icon={<Clock className="w-5 h-5" />} text="Uptime" />
        <div className="flex items-center justify-center py-2">
          <span style={{ ...bigNum, ...muted }}>—</span>
        </div>
      </Card>

      {/* Версия */}
      <Card padding="md" style={{ flex: "1 1 220px" }}>
        <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
        <div className="flex items-center justify-center py-2">
          <span style={bigNum}>{version}</span>
        </div>
      </Card>

      {/* ── Row 3: Безопасность | Нагрузка ── */}

      {/* Безопасность — частично реальные данные */}
      <Card padding="md" style={{ flex: "1 1 340px" }}>
        <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
        <div className="grid grid-cols-2 gap-2 mt-1">
          {[
            { name: "Firewall", ok: null, label: "—" },
            { name: "Fail2Ban", ok: null, label: "—" },
            { name: "SSH-ключ", ok: null, label: "—" },
            { name: "TLS", ok: hasTls, label: hasTls ? "Активен" : "—" },
          ].map((item) => {
            const bg = item.ok === null
              ? "var(--color-bg-elevated)"
              : item.ok
                ? "rgba(var(--color-status-connected-rgb, 16 185 129) / 0.08)"
                : "rgba(var(--color-status-error-rgb, 224 85 69) / 0.08)";
            const color = item.ok === null
              ? "var(--color-text-muted)"
              : item.ok ? "var(--color-success-500)" : "var(--color-danger-500)";
            return (
              <div key={item.name} className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: bg }}>
                <div className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{item.name}</div>
                <div className="text-sm" style={{ color }}>{item.label}</div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Нагрузка — заглушка */}
      <Card padding="md" style={{ flex: "2 1 400px" }}>
        <Title icon={<Gauge className="w-5 h-5" />} text="Нагрузка" />
        <div className="space-y-2.5 mt-1">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm" style={muted}>CPU</span>
              <span className="text-sm" style={muted}>—</span>
            </div>
            <ProgressBar value={0} size="sm" color="success" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm" style={muted}>RAM</span>
              <span className="text-sm" style={muted}>—</span>
            </div>
            <ProgressBar value={0} size="sm" color="accent" />
          </div>
        </div>
      </Card>
    </div>
  );
}
