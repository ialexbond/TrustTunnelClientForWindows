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
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { ProgressBar } from "../../shared/ui/ProgressBar";
import { Skeleton } from "../../shared/ui/Skeleton";
import { EcgSvg, ecgHeartbeat, ecgFlatline } from "../../shared/ui/EcgSvg";
import type { ServerState } from "./useServerState";
import { useServerStats } from "./useServerStats";
import { useServerGeoIp } from "./useServerGeoIp";
import { formatServerUptime } from "../../shared/utils/uptime";
import { parseCertInfo, daysUntil } from "./certUtils";
import { useActivityLog } from "../../shared/hooks/useActivityLog";

type TabId = "overview" | "users" | "configuration" | "security" | "utilities";

/* ═══════════════════════════════════════════════════════
   OverviewSection — 10 карточек обзора сервера
   flex-wrap layout, 3 ряда при ≥1000px
   ═══════════════════════════════════════════════════════ */

interface Props {
  state: ServerState;
  activeServerTab?: TabId;
  onNavigate?: (tab: TabId) => void;
}

export type { TabId };

/* ── Shared styles ── */
const muted: React.CSSProperties = { color: "var(--color-text-muted)" };
const primary: React.CSSProperties = { color: "var(--color-text-primary)" };
const accent: React.CSSProperties = { color: "var(--color-accent-interactive)" };
const bigNum: React.CSSProperties = { fontSize: "2rem", fontWeight: 600, lineHeight: 1, color: "var(--color-text-primary)" };
const danger: React.CSSProperties = { color: "var(--color-danger-500)" };

/* ── Title ── */
function Title({ icon, text, onRefresh, refreshing, clickable, refreshAriaLabel }: {
  icon: React.ReactNode;
  text: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  clickable?: boolean;
  refreshAriaLabel: string;
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
            aria-label={refreshAriaLabel}
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

/* ── ClickableCard — вся карточка как кнопка (D-09 a11y) ── */
function ClickableCard({
  children,
  onClick,
  ariaLabel,
  style,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  style?: React.CSSProperties;
}) {
  return (
    <Card
      padding="md"
      style={style}
      className="cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors focus-visible:shadow-[var(--focus-ring)] outline-none"
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </Card>
  );
}

/**
 * Localize country name based on i18n locale via browser Intl.DisplayNames API.
 * Returns localized name (e.g. "DE" + "ru" → "Германия", "DE" + "en" → "Germany").
 * Fallback на оригинальное name если API не сработает (старые webview, missing data).
 */
function getLocalizedCountry(countryCode: string, fallback: string, locale: string): string {
  if (!countryCode) return fallback;
  try {
    const display = new Intl.DisplayNames([locale], { type: "region" });
    const localized = display.of(countryCode.toUpperCase());
    return localized && localized !== countryCode.toUpperCase() ? localized : fallback;
  } catch {
    return fallback;
  }
}

export function OverviewSection({ state, activeServerTab, onNavigate }: Props) {
  const { t, i18n } = useTranslation();
  const { log: activityLog } = useActivityLog();
  const { serverInfo, sshParams, rebooting, setRebooting, setServerInfo } = state;

  // ─── Live data hooks (Phase 13) ───
  const isOverviewVisible = activeServerTab === undefined || activeServerTab === "overview";
  const { stats, loading: statsLoading } = useServerStats(sshParams, {
    enabled: isOverviewVisible && !rebooting && !!serverInfo,
    intervalMs: 10_000,
  });
  const { geo, loading: geoLoading } = useServerGeoIp({ host: state.host });

  const [ping, setPing] = useState<number | null>(null);
  // G-08: guard против rapid-fire ping клика — иначе каждый tick открывает новый
  // SSH channel на общий pool (single handle, MaxSessions ~10). 4 пинга за секунду
  // + stats poller + security + fastUptime → SSH_CHANNEL_FAILED на следующей команде.
  const [pingLoading, setPingLoading] = useState(false);
  const [rebootCountdown, setRebootCountdown] = useState(0);
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Speed test (BUG fix — manual, не polling) ──
  const [speed, setSpeed] = useState<{ download_mbps: number; upload_mbps: number } | null>(null);
  const [speedTesting, setSpeedTesting] = useState(false);
  // G-05: различаем "ни разу не запускался" (null + !failed → "Не измерялась")
  // от "попробовал, упало" (null + failed → "—"). Иначе после failed test UI
  // выглядит как будто speedtest не запускался.
  const [speedFailed, setSpeedFailed] = useState(false);

  const runSpeedTest = useCallback(async () => {
    if (speedTesting) return;
    activityLog("USER", "overview.speedtest.started", "OverviewSection.SpeedRefresh");
    setSpeedTesting(true);
    setSpeedFailed(false);
    try {
      // Client-side speedtest: твой ПК → Cloudflare. Если VPN-клиент подключён к этому
      // серверу — трафик идёт через VPN-туннель, измеряется реальная VPN throughput
      // (включая overhead encryption + MTU + server queue). Если VPN не подключён —
      // измеряется голая клиентская сеть.
      const r = await invoke<{ download_mbps: number; upload_mbps: number }>("speedtest_run");
      setSpeed(r);
      activityLog("STATE", `overview.speedtest.completed dl=${r.download_mbps.toFixed(1)} ul=${r.upload_mbps.toFixed(1)}`, "speedtest_run");
    } catch (e) {
      setSpeed(null);
      setSpeedFailed(true);
      activityLog("ERROR", `overview.speedtest.failed err=${String(e)}`, "speedtest_run");
    } finally {
      setSpeedTesting(false);
    }
  }, [speedTesting, activityLog]);

  // ── Fast standalone uptime poller (Phase 13.UAT G-01 C) — независимо от
  //    server_get_stats (который тормозится sleep 1 для CPU sampling).
  //    `cat /proc/uptime` возвращается за <100ms → Uptime card появляется
  //    почти мгновенно, не ждёт CPU/RAM. Polling 10s как и у stats.
  const [fastUptime, setFastUptime] = useState<number | null>(null);

  useEffect(() => {
    if (!serverInfo?.serviceActive || rebooting || !isOverviewVisible) return;
    let cancelled = false;
    const fetchUptime = () => {
      invoke<{ uptime_seconds: number }>("server_get_uptime", sshParams)
        .then((r) => { if (!cancelled) setFastUptime(r.uptime_seconds); })
        .catch(() => { /* silent — stats fallback handles display */ });
    };
    fetchUptime(); // immediate
    const interval = setInterval(fetchUptime, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sshParams, serverInfo?.serviceActive, rebooting, isOverviewVisible]);

  // ── Security status (firewall + fail2ban) — on-demand, не polling ──
  const [security, setSecurity] = useState<{ firewall: { installed: boolean; active: boolean }; fail2ban: { installed: boolean; active: boolean } } | null>(null);
  const [securityLoading, setSecurityLoading] = useState(false);

  useEffect(() => {
    if (!serverInfo?.serviceActive || rebooting) return;
    setSecurityLoading(true);
    invoke<{ firewall: { installed: boolean; active: boolean }; fail2ban: { installed: boolean; active: boolean } }>(
      "security_get_status",
      sshParams,
    )
      .then((s) => {
        setSecurity(s);
        activityLog(
          "STATE",
          `overview.security.loaded firewall=${s.firewall.active ? "active" : s.firewall.installed ? "inactive" : "missing"} fail2ban=${s.fail2ban.active ? "active" : s.fail2ban.installed ? "inactive" : "missing"}`,
          "security_get_status",
        );
      })
      .catch((e) => {
        setSecurity(null);
        activityLog("ERROR", `overview.security.failed err=${String(e)}`, "security_get_status");
      })
      .finally(() => setSecurityLoading(false));
  }, [sshParams, serverInfo?.serviceActive, rebooting, activityLog]);

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
  // WR-01 fix: use a ref-based stable handle so the 1-shot effect (deps=[rebooting]) always
  // reads CURRENT sshParams/host/callbacks, not the stale values captured when rebooting=true.
  // Pre-fix symptom: if user changed SSH port via handlePortChanged during reboot, poller
  // kept calling check_server_installation / ping_endpoint on the OLD port until 2-min timeout.
  const rebootRefs = useRef({
    sshParams,
    host: state.host,
    setRebooting,
    setServerInfo,
    t,
    pushSuccess: state.pushSuccess,
  });
  rebootRefs.current = {
    sshParams,
    host: state.host,
    setRebooting,
    setServerInfo,
    t,
    pushSuccess: state.pushSuccess,
  };

  useEffect(() => {
    if (!rebooting) return;
    let elapsed = 0;
    const interval = setInterval(async () => {
      elapsed += 10;
      setRebootCountdown(elapsed);
      const refs = rebootRefs.current;
      try {
        const info = await invoke<{ installed: boolean; version: string; serviceActive: boolean; users: string[] }>(
          "check_server_installation", refs.sshParams
        );
        if (info) {
          refs.setRebooting(false);
          setRebootCountdown(0);
          refs.setServerInfo(info);
          refs.pushSuccess(refs.t("server.actions.success_reboot_done"));
          invoke<number>("ping_endpoint", { host: refs.host, port: 443 })
            .then((ms) => setPing(ms))
            .catch(() => setPing(-1));
        }
      } catch {
        if (elapsed >= 120) {
          refs.setRebooting(false);
          setRebootCountdown(0);
          invoke("clear_ssh_credentials").catch(() => {});
          localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());
        }
      }
    }, 10000);
    return () => clearInterval(interval);
    // Effect intentionally runs once per reboot cycle (deps=[rebooting]). Fresh closures
    // would spawn duplicate intervals → SSH-storm on wake. All mutable refs come via
    // rebootRefs.current, which is updated on every render above.
  }, [rebooting]);

  const refreshPing = useCallback(() => {
    if (pingLoading) return;
    activityLog("USER", "overview.ping.manual_refresh", "OverviewSection.PingRefresh");
    setPingLoading(true);
    invoke<number>("ping_endpoint", { host: state.host, port: 443 })
      .then((ms) => {
        setPing(ms);
        activityLog("STATE", `overview.ping.result ms=${ms}`, "ping_endpoint");
      })
      .catch((e) => {
        setPing(-1);
        activityLog("ERROR", `overview.ping.failed err=${String(e)}`, "ping_endpoint");
      })
      .finally(() => setPingLoading(false));
  }, [pingLoading, state.host, activityLog]);

  // ── Skeleton: пока нет данных ──
  const refreshAriaLabel = t("server.overview.refreshAria");
  if (!serverInfo) {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, width: "100%" }}>
        {[
          { icon: <HeartPulse className="w-5 h-5" />, text: t("server.overview.cards.status"), flex: "1 1 220px", maxWidth: "260px", h: 56 },
          { icon: <Activity className="w-5 h-5" />, text: t("server.overview.cards.ping"), flex: "1 1 140px", maxWidth: "180px", h: 48 },
          { icon: <Zap className="w-5 h-5" />, text: t("server.overview.cards.speed"), flex: "2 1 340px", h: 48 },
          { icon: <Users className="w-5 h-5" />, text: t("server.overview.cards.userCount"), flex: "1 1 180px", h: 48 },
          { icon: <Network className="w-5 h-5" />, text: t("server.overview.cards.ip"), flex: "1 1 240px", h: 48 },
          { icon: <Globe className="w-5 h-5" />, text: t("server.overview.cards.country"), flex: "1 1 180px", h: 36 },
          { icon: <Clock className="w-5 h-5" />, text: t("server.overview.cards.uptime"), flex: "1 1 160px", h: 48 },
          { icon: <Package className="w-5 h-5" />, text: t("server.overview.cards.protocolVersion"), flex: "1 1 220px", h: 48 },
        ].map((c) => (
          <Card key={c.text} padding="md" style={{ flex: c.flex, maxWidth: c.maxWidth }}>
            <Title icon={c.icon} text={c.text} refreshAriaLabel={refreshAriaLabel} />
            <div className="flex items-center justify-center py-2" style={{ minHeight: c.h }}>
              <Skeleton variant="line" width={100} height={32} />
            </div>
          </Card>
        ))}
        <Card padding="md" style={{ flex: "1 1 340px" }}>
          <Title icon={<Shield className="w-5 h-5" />} text={t("server.overview.cards.security")} refreshAriaLabel={refreshAriaLabel} />
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
          <Title icon={<Gauge className="w-5 h-5" />} text={t("server.overview.cards.load")} refreshAriaLabel={refreshAriaLabel} />
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
  // TLS expiry calculation (3 states: >14d green, 7-14d warning, ≤7d danger)
  const certInfo = state.certRaw ? parseCertInfo(state.certRaw) : null;
  const tlsDaysLeft = certInfo?.notAfter ? daysUntil(certInfo.notAfter) : null;
  const tlsState: "ok" | "warning" | "danger" | null = !hasTls
    ? null
    : tlsDaysLeft === null
      ? "ok"
      : tlsDaysLeft <= 7
        ? "danger"
        : tlsDaysLeft <= 14
          ? "warning"
          : "ok";
  const tlsLabel = !hasTls
    ? t("server.overview.security.placeholder")
    : tlsDaysLeft === null
      ? t("server.overview.security.tlsActive")
      : tlsDaysLeft <= 0
        ? t("server.overview.security.tlsExpired")
        : t("server.overview.security.tlsDays", { days: tlsDaysLeft });

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, width: "100%" }}>

      {/* ── Row 1: Status | Ping | Speed | Users ── */}

      {/* Status — ECG */}
      <Card padding="md" style={{ flex: "1 1 220px" }}>
        <Title icon={<HeartPulse className="w-5 h-5" />} text={t("server.overview.cards.status")} refreshAriaLabel={refreshAriaLabel} />
        {rebooting ? (
          <div className="flex flex-col items-center justify-center gap-1.5 py-1">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--color-warning-500)" }} />
            <span className="text-sm" style={{ color: "var(--color-warning-500)" }}>
              {t("server.overview.rebootingCountdown")}{rebootCountdown > 0 ? ` ${rebootCountdown}s` : "..."}
            </span>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-1.5 py-1">
            {/* key={isRunning ? "live" : "dead"} — заставит React unmount + remount SVG
                при смене состояния, чтобы CSS animationDelay (-0.55s ... 0s) применились
                к свежим layered paths и фазы layer-ов синхронизировались.
                Без key React переиспользует старый <svg>, animations продолжают идти
                с прежнего timing → bright/dim layers рассогласовываются → tail/head перепутываются. */}
            <EcgSvg
              key={isRunning ? "live" : "dead"}
              color={isRunning ? "var(--color-success-500)" : "var(--color-danger-500)"}
              path={isRunning ? ecgHeartbeat : ecgFlatline}
              anim={isRunning ? "ecg-live" : "ecg-dead"}
            />
            <span className="text-sm" style={isRunning ? muted : danger}>
              {isRunning ? t("server.status.running") : t("server.status.stopped")}
            </span>
          </div>
        )}
      </Card>

      {/* Ping — refresh скрыт когда протокол off (UAT consistency со Speed карточкой) */}
      <Card padding="md" style={{ flex: "1 1 140px" }}>
        <Title
          icon={<Activity className="w-5 h-5" />}
          text={t("server.overview.cards.ping")}
          onRefresh={isRunning && !rebooting ? refreshPing : undefined}
          refreshing={pingLoading}
          refreshAriaLabel={refreshAriaLabel}
        />
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

      {/* Speed — server-side speedtest via SSH+curl на Cloudflare (Phase 13.UAT).
          Измеряет server bandwidth (потолок VPN throughput). Refresh disabled
          когда протокол остановлен или ребутится — тест бессмысленный.
          Design: Screens/Overview Cards story 3a — coloured ↓↑ icons + значение + Мбит/с. */}
      <Card padding="md" style={{ flex: "1 1 280px", maxWidth: 360 }}>
        <Title
          icon={<Zap className="w-5 h-5" />}
          text={t("server.overview.cards.speed")}
          onRefresh={isRunning && !rebooting ? runSpeedTest : undefined}
          refreshing={speedTesting}
          refreshAriaLabel={refreshAriaLabel}
        />
        {!isRunning || rebooting ? (
          <div className="flex items-center justify-center py-2" style={{ minHeight: 48 }}>
            <span className="text-sm" style={muted}>{t("server.overview.speedRequiresProtocol")}</span>
          </div>
        ) : speedTesting ? (
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
        ) : speed ? (
          <div className="flex items-center justify-center gap-4 py-2" style={{ minHeight: 48 }}>
            <div className="flex items-center gap-1.5" style={{ minWidth: 100 }}>
              <ArrowDown className="w-6 h-6 shrink-0" style={{ color: "var(--color-success-400)" }} />
              <div className="flex items-baseline gap-1">
                <span style={bigNum}>{Math.round(speed.download_mbps)}</span>
                <span className="text-sm whitespace-nowrap" style={muted}>{t("server.overview.speedUnit")}</span>
              </div>
            </div>
            <div className="h-7 shrink-0" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
            <div className="flex items-center gap-1.5" style={{ minWidth: 100 }}>
              <ArrowUp className="w-6 h-6 shrink-0" style={{ color: "var(--color-warning-500)" }} />
              <div className="flex items-baseline gap-1">
                <span style={bigNum}>{Math.round(speed.upload_mbps)}</span>
                <span className="text-sm whitespace-nowrap" style={muted}>{t("server.overview.speedUnit")}</span>
              </div>
            </div>
          </div>
        ) : speedFailed ? (
          <div className="flex items-center justify-center py-2" style={{ minHeight: 48 }}>
            <span style={{ ...bigNum, ...muted }}>—</span>
          </div>
        ) : (
          <div className="flex items-center justify-center py-2" style={{ minHeight: 48 }}>
            <span className="text-sm" style={muted}>{t("server.overview.speedNotMeasured")}</span>
          </div>
        )}
      </Card>

      {/* Users — drill-down (D-11) */}
      <ClickableCard
        style={{ flex: "1 1 180px" }}
        onClick={() => onNavigate?.("users")}
        ariaLabel={t("server.overview.cards.userCount")}
      >
        <Title icon={<Users className="w-5 h-5" />} text={t("server.overview.cards.userCount")} clickable refreshAriaLabel={refreshAriaLabel} />
        <div className="flex items-center justify-center py-2">
          <span style={userCount > 0 ? bigNum : { ...bigNum, ...muted }}>{userCount}</span>
        </div>
      </ClickableCard>

      {/* ── Row 2: IP | Country | Uptime | Version ── */}

      {/* IP */}
      <Card padding="md" style={{ flex: "1 1 240px" }}>
        <Title icon={<Network className="w-5 h-5" />} text={t("server.overview.cards.ip")} refreshAriaLabel={refreshAriaLabel} />
        <div className="flex items-center justify-center py-2">
          <span style={bigNum}>{state.host || "—"}</span>
        </div>
      </Card>

      {/* Country — live (D-05) */}
      <Card padding="md" style={{ flex: "1 1 180px" }}>
        <Title icon={<Globe className="w-5 h-5" />} text={t("server.overview.cards.country")} refreshAriaLabel={refreshAriaLabel} />
        <div className="flex items-center justify-center py-2">
          {geoLoading ? (
            <Skeleton variant="line" width={120} height={28} />
          ) : geo ? (
            <span style={bigNum} className="flex items-center gap-2" data-testid="country-card-value">
              {/* M-06: ipwho.is возвращает готовый emoji флаг (U+1F1XX regional
                  indicators). Показываем его слева от страны — проще, чем
                  тянуть SVG-флаги из flag-icons или подобного пакета. Emoji
                  рендерится через system font на Windows 11 (Segoe UI Emoji). */}
              {geo.flag_emoji && (
                <span
                  aria-hidden="true"
                  className="text-xl leading-none"
                  // M-06 follow-up: force Twemoji Country Flags as the primary
                  // family for this span. Windows native Segoe UI Emoji does
                  // NOT render regional indicator pairs as flags — it shows
                  // "RU"/"NL" letter glyphs. The @font-face injected by
                  // `polyfillCountryFlagEmojis()` in main.tsx provides the
                  // missing flag glyphs; system-ui is the fallback for
                  // platforms that already handle flags natively.
                  style={{ fontFamily: '"Twemoji Country Flags", system-ui, sans-serif' }}
                >
                  {geo.flag_emoji}
                </span>
              )}
              <span>{getLocalizedCountry(geo.country_code, geo.country, i18n.language)}</span>
            </span>
          ) : (
            <span className="text-xl font-[var(--font-weight-semibold)]" style={muted}>—</span>
          )}
        </div>
      </Card>

      {/* Uptime — fast uptime (server_get_uptime, <100ms) fallback на stats.uptime_seconds.
          Fast polling независим от server_get_stats (тормозится sleep 1 для CPU%). */}
      <Card padding="md" style={{ flex: "1 1 160px" }}>
        <Title icon={<Clock className="w-5 h-5" />} text={t("server.overview.cards.uptime")} refreshAriaLabel={refreshAriaLabel} />
        <div className="flex items-center justify-center py-2">
          {fastUptime !== null ? (
            <span style={bigNum}>{formatServerUptime(fastUptime, t)}</span>
          ) : stats ? (
            <span style={bigNum}>{formatServerUptime(stats.uptime_seconds, t)}</span>
          ) : statsLoading ? (
            <Skeleton variant="line" width={80} height={28} />
          ) : (
            <span style={{ ...bigNum, ...muted }}>—</span>
          )}
        </div>
      </Card>

      {/* Protocol version — drill-down (D-11) */}
      <ClickableCard
        style={{ flex: "1 1 220px" }}
        onClick={() => onNavigate?.("configuration")}
        ariaLabel={t("server.overview.cards.protocolVersion")}
      >
        <Title icon={<Package className="w-5 h-5" />} text={t("server.overview.cards.protocolVersion")} clickable refreshAriaLabel={refreshAriaLabel} />
        <div className="flex items-center justify-center py-2">
          <span style={bigNum}>{version}</span>
        </div>
      </ClickableCard>

      {/* ── Row 3: Security | Load ── */}

      {/* Security — drill-down (D-11). Skeleton state per Screens/Overview Cards 9f.
          flex basis 300 + Load 300 = 600, помещаются в одном ряду даже при minWidth
          800px контейнера (G-09 fix — убрать split в 5-й ряд на узкой ширине). */}
      <ClickableCard
        style={{ flex: "1 1 300px" }}
        onClick={() => onNavigate?.("security")}
        ariaLabel={t("server.overview.cards.security")}
      >
        <Title icon={<Shield className="w-5 h-5" />} text={t("server.overview.cards.security")} clickable refreshAriaLabel={refreshAriaLabel} />
        {security === null && securityLoading ? (
          <div className="grid grid-cols-2 gap-2 mt-1">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <Skeleton variant="line" width={70} height={14} className="mb-1.5" />
                <Skeleton variant="line" width={50} height={14} />
              </div>
            ))}
          </div>
        ) : (
        <div className="grid grid-cols-2 gap-2 mt-1">
          {[
            {
              name: t("server.overview.security.firewall"),
              ok: security?.firewall.active ?? null,
              label: security?.firewall.active
                ? t("server.overview.security.active")
                : security?.firewall.installed === false
                  ? t("server.overview.security.notInstalled")
                  : security?.firewall.installed
                    ? t("server.overview.security.inactive")
                    : t("server.overview.security.placeholder"),
            },
            {
              name: t("server.overview.security.fail2ban"),
              ok: security?.fail2ban.active ?? null,
              label: security?.fail2ban.active
                ? t("server.overview.security.active")
                : security?.fail2ban.installed === false
                  ? t("server.overview.security.notInstalled")
                  : security?.fail2ban.installed
                    ? t("server.overview.security.inactive")
                    : t("server.overview.security.placeholder"),
            },
            { name: t("server.overview.security.sshKey"), ok: null as boolean | null, label: t("server.overview.security.placeholder"), tone: null as "ok" | "warning" | "danger" | null },
            { name: t("server.overview.security.tls"), ok: hasTls, label: tlsLabel, tone: tlsState },
          ].map((item) => {
            // tone — explicit 3-state (ok/warning/danger) for TLS; ok — boolean for firewall/fail2ban.
            const tone = (item as { tone?: "ok" | "warning" | "danger" | null }).tone
              ?? (item.ok === null ? null : item.ok ? "ok" : "danger");
            const bg = tone === null
              ? "var(--color-bg-elevated)"
              : tone === "ok"
                ? "rgba(var(--color-status-connected-rgb, 16 185 129) / 0.08)"
                : tone === "warning"
                  ? "rgba(var(--color-status-warning-rgb, 234 179 8) / 0.08)"
                  : "rgba(var(--color-status-error-rgb, 224 85 69) / 0.08)";
            const color = tone === null
              ? "var(--color-text-muted)"
              : tone === "ok"
                ? "var(--color-success-500)"
                : tone === "warning"
                  ? "var(--color-warning-500)"
                  : "var(--color-danger-500)";
            return (
              <div key={item.name} className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: bg }}>
                <div className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{item.name}</div>
                <div className="text-sm" style={{ color }}>{item.label}</div>
              </div>
            );
          })}
        </div>
        )}
      </ClickableCard>

      {/* Load — live (CPU + RAM). Skeleton state per Screens/Overview Cards 10c:
          ALL elements skeletoned (label + value + bar) — никаких текстов CPU/RAM.
          flex basis 300 (G-09) — парный с Security чтобы держать Row 3 в одну строку. */}
      <Card padding="md" style={{ flex: "1 1 300px" }}>
        <Title icon={<Gauge className="w-5 h-5" />} text={t("server.overview.cards.load")} refreshAriaLabel={refreshAriaLabel} />
        <div className="space-y-2.5 mt-1">
          {stats === null && statsLoading ? (
            // Full skeleton state — no labels, just placeholders
            [1, 2].map((i) => (
              <div key={i}>
                <div className="flex items-center justify-between mb-1">
                  <Skeleton variant="line" width={30} height={20} />
                  <Skeleton variant="line" width={60} height={20} />
                </div>
                <Skeleton variant="line" width="100%" height={6} />
              </div>
            ))
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm" style={muted}>CPU</span>
                  {stats ? (
                    <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{Math.round(stats.cpu_percent)}%</span>
                  ) : (
                    <span className="text-sm" style={muted}>—</span>
                  )}
                </div>
                <ProgressBar value={stats ? Math.min(100, Math.max(0, stats.cpu_percent)) : 0} size="sm" color="success" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm" style={muted}>RAM</span>
                  {stats && stats.mem_total > 0 ? (
                    <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>
                      {Math.round(stats.mem_used / 1024 / 1024)} / {Math.round(stats.mem_total / 1024 / 1024)} {t("server.overview.ramUnit")}
                    </span>
                  ) : (
                    <span className="text-sm" style={muted}>—</span>
                  )}
                </div>
                <ProgressBar
                  value={stats && stats.mem_total > 0 ? Math.round((stats.mem_used / stats.mem_total) * 100) : 0}
                  size="sm"
                  color="accent"
                />
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
