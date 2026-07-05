import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
  ArrowUpCircle,
  Eye,
  EyeOff,
} from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { IconButton } from "../../shared/ui/IconButton";
import { IpDustOverlay } from "../../shared/ui/IpDustOverlay";
import { ProgressBar } from "../../shared/ui/ProgressBar";
import { Skeleton } from "../../shared/ui/Skeleton";
import { EcgSvg, ecgHeartbeat, ecgFlatline } from "../../shared/ui/EcgSvg";
import type { ServerState } from "./useServerState";
import { useServerStats } from "./useServerStats";
import { useServerGeoIp } from "./useServerGeoIp";
import { formatServerUptime } from "../../shared/utils/uptime";
import { parseCertInfo, daysUntil } from "./certUtils";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { useDocumentVisible } from "../../shared/hooks/useDocumentVisible";
import type { ServerTabId } from "../../shared/types";

// Re-export ServerTabId as TabId here so this component keeps its existing
// public `TabId` type-alias (consumed by ServerTabs.tsx via re-export). Phase
// 19 rename: "utilities" → "service" (D-04 + UI-SPEC §Block 3 §A).
type TabId = ServerTabId;

/* ═══════════════════════════════════════════════════════
   OverviewSection — 10 карточек обзора сервера
   flex-wrap layout, 3 ряда при ≥1000px
   ═══════════════════════════════════════════════════════ */

interface Props {
  state: ServerState;
  activeServerTab?: TabId;
  onNavigate?: (tab: TabId) => void;
  /**
   * Phase 19 (UI-SPEC §Block 3): when truthy, Card #8 «Версия протокола»
   * shows an ArrowUp icon (warning-500) next to the version label to hint
   * that an update is available. Clicking the card now navigates to the
   * «Сервис» tab (not «Конфигурация») — drill-down bug fix per UI-SPEC.
   */
  sidecarAvailable?: boolean;
}

export type { TabId };

/* ── Shared styles ── */
const muted: React.CSSProperties = { color: "var(--color-text-muted)" };
const primary: React.CSSProperties = { color: "var(--color-text-primary)" };
const accent: React.CSSProperties = { color: "var(--color-accent-interactive)" };
// Card big-number value — token-driven (UI-REVIEW Typography BLOCKER). Was a
// hardcoded `2rem`/`600`; now --font-size-card-value (32px) + --font-weight-semibold
// so a card-value retune lives in tokens.css, not scattered inline styles.
const bigNum: React.CSSProperties = { fontSize: "var(--font-size-card-value)", fontWeight: "var(--font-weight-semibold)", lineHeight: 1, color: "var(--color-text-primary)" };
// CP-2b (16-12, REVERT of 16-09): the owner rejected the shrunk country font —
// he wants the country value at the SAME size as the other metric cards
// (Uptime/Version/IP = bigNum, --font-size-card-value 32px), just kept on ONE
// line. The 16-09 fix mistakenly reduced it to --font-size-title-sm (20px). We
// revert to the bigNum size (lineHeight nudged to 1.1 for the flag row) and
// achieve one-line via whitespace-nowrap + overflow-hidden/text-ellipsis + a
// title (applied at the JSX span) so a pathologically long name is ellipsized at
// FULL size rather than shrunk or wrapped. See 16-UAT-ROUND3 gap CP-2b.
const countryValue: React.CSSProperties = { fontSize: "var(--font-size-card-value)", fontWeight: "var(--font-weight-semibold)", lineHeight: 1.1, color: "var(--color-text-primary)" };
const danger: React.CSSProperties = { color: "var(--color-danger-500)" };

// D-10 (Plan 07-06, post-UAT scope): perceptible press-state — a native-app
// push-in feel — applied ONLY to the clickable drill-down cards (Users / Protocol
// Version / Security via ClickableCard). The user rejected press feedback on the
// plain info cards: a press animation on a non-actionable card reads as "this is
// clickable" when it is not, which is misleading. So the plain Status/Ping/Speed/
// IP/Country/Uptime/Load cards carry NO press-state. active:bg darkens on press,
// active:scale-[0.98] pushes in 2%, transform-origin keeps the squeeze centered.
// The transform/background transition runs over --transition-fast (150ms) so the
// press reads as a quick, tactile response (token collapses to 0ms under
// prefers-reduced-motion → the scale applies instantly, which is acceptable).
const PRESS_STATE_CLASS =
  "active:bg-[var(--color-bg-active)] active:scale-[0.98] origin-center transition-[transform,background-color] duration-[var(--transition-fast)] ease-[var(--ease-out)]";

// Overview card rule (owner UAT): the error caption is NEVER truncated and NEVER
// line-capped — it wraps to as many lines as the width needs. This is the shared
// MINIMUM flex-basis an error-capable card (Ping / Speed) adopts WHILE in its
// error state: wide enough that the full «Не удалось получить данные. Проверьте
// подключение и нажмите «Обновить».» caption lands in ~2 lines at the normal
// width. On a narrower window the card just wraps taller (3–4 lines) and grows —
// it only stops shrinking at this basis (the floor below which it won't compress).
// Sized to the same 280px the Speed card uses; Ping's compact 140px basis widens
// to this only on error.
const ERROR_CARD_MIN_BASIS = 280;

/* ── Title ── */
function Title({ icon, text, onRefresh, refreshing, clickable, refreshAriaLabel, action }: {
  icon: React.ReactNode;
  text: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  clickable?: boolean;
  refreshAriaLabel: string;
  // D-08 (Plan 07-06): optional right-side action node — used by the IP card to
  // host the Eye/EyeOff reveal button. Lives in the SAME fixed-height action row
  // as refresh/chevron, so adding it never reflows the card title (no layout shift).
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-3" style={{ height: 32 }}>
      {/* Title rule (owner UAT): NEVER truncate the title to «…». whitespace-nowrap
          keeps it on one line and — with NO min-w-0 on this block — the flex item's
          automatic min-width floors the card to (icon + full title + action) width.
          So the card grows to fit the whole title AND the chevron never overflows
          the frame (the card simply can't get narrower than its content). */}
      <div className="flex items-center gap-2 h-full">
        <span className="flex items-center justify-center w-5 h-5 shrink-0" style={accent}>{icon}</span>
        <span className="text-title-sm whitespace-nowrap" style={primary}>{text}</span>
      </div>
      <div className="flex items-center h-full shrink-0 ml-1">
        {action}
        {onRefresh && (
          // A-1 (Plan 09-19): adopt the shared IconButton primitive instead of a
          // hand-rolled <button> with a RefreshCw/Loader2 swap. IconButton owns
          // the h-8 w-8 box, focus-ring, hover/active states, and the loading
          // spinner swap (loading → Loader2). aria-busy is forwarded via ...rest
          // so AT users hear the in-flight state; the button also disables while
          // loading (IconButton sets disabled = disabled || loading).
          <IconButton
            icon={<RefreshCw className="w-4 h-4" />}
            aria-label={refreshAriaLabel}
            aria-busy={refreshing}
            loading={refreshing}
            onClick={onRefresh}
          />
        )}
        {clickable && (
          // Chevron affordance rule (owner UAT): the › occupies the SAME 32px box as
          // the refresh IconButton (w-8 h-8, glyph centered), so the right-side
          // affordance sits at the same inset from the card edge AND keeps a clear gap
          // from the (truncating) title — instead of a bare glyph jammed against the
          // edge. The whole card is the button, so the chevron needs no hover box of
          // its own; the box is purely for consistent spacing/rhythm with refresh cards.
          <span className="flex items-center justify-center w-8 h-8 shrink-0" style={muted}>
            <ChevronRight className="w-5 h-5" />
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
      // D-10 (Plan 07-06): extend the existing press pattern with active:scale-[0.98]
      // + a transform/background transition (PRESS_STATE_CLASS). The press-scale is
      // on the SAME element as the focus ring — focus-visible:shadow-[var(--focus-ring)]
      // is kept explicitly so the keyboard focus ring still renders on the
      // clickable drill-down cards (Users / Version / Security).
      className={`cursor-pointer hover:bg-[var(--color-bg-hover)] focus-visible:shadow-[var(--focus-ring)] outline-none ${PRESS_STATE_CLASS}`}
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

/* ── OverviewSkeleton — the 10-card placeholder grid ──
   Extracted verbatim from the original `serverInfo === null` branch so it can be
   reused as the D-07 all-cards-loaded gate (Plan 07-06) WITHOUT authoring a new
   loading visual. Same flex/gap/sub-tile shape as the real grid, so the swap to
   real content never jumps the layout. Takes only `t` + `refreshAriaLabel`. */
function OverviewSkeleton({ t, refreshAriaLabel }: { t: TFunction; refreshAriaLabel: string }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, width: "100%" }}>
      {[
        { icon: <HeartPulse className="w-5 h-5" />, text: t("server.overview.cards.status"), flex: "1 1 220px", h: 56 },
        { icon: <Activity className="w-5 h-5" />, text: t("server.overview.cards.ping"), flex: "1 1 140px", h: 48 },
        { icon: <Zap className="w-5 h-5" />, text: t("server.overview.cards.speed"), flex: "1 1 280px", maxWidth: "360px", h: 48 },
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
      <Card padding="md" style={{ flex: "1 1 300px" }}>
        <Title icon={<Shield className="w-5 h-5" />} text={t("server.overview.cards.security")} refreshAriaLabel={refreshAriaLabel} />
        {/* D-04 / H-03 (Plan 04-14): 3 sub-tiles to match the loaded layout
            (Firewall / Fail2Ban / TLS — SSH-key removed in Phase 16). A 4-tile
            skeleton produced a visible 4→3 jump when serverInfo arrived. */}
        <div className="grid grid-cols-2 gap-2 mt-1">
          {[1, 2, 3].map(i => (
            <div key={i} data-testid="security-skeleton-tile" className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
              <Skeleton variant="line" width={60} height={14} className="mb-1" />
              <Skeleton variant="line" width={50} height={14} />
            </div>
          ))}
        </div>
      </Card>
      <Card padding="md" style={{ flex: "1 1 300px" }}>
        <Title icon={<Gauge className="w-5 h-5" />} text={t("server.overview.cards.load")} refreshAriaLabel={refreshAriaLabel} />
        <div className="space-y-2 mt-1">
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

export function OverviewSection({ state, activeServerTab, onNavigate, sidecarAvailable = false }: Props) {
  const { t, i18n } = useTranslation();
  const { log: activityLog } = useActivityLog();
  const { serverInfo, sshParams, rebooting, setRebooting, setServerInfo, usersKnown } = state;

  // ─── Live data hooks (Phase 13) ───
  const isOverviewVisible = activeServerTab === undefined || activeServerTab === "overview";
  // QE-05 (Plan 09-19): pause the interval pollers when the window is hidden
  // (minimized / backgrounded tab) — the user can't see the data, so the SSH
  // polls are pure waste. The reboot poller is the documented EXCEPTION (it must
  // keep running even when hidden so recovery is detected — see its effect).
  const windowVisible = useDocumentVisible();
  const { stats, loading: statsLoading } = useServerStats(sshParams, {
    enabled: isOverviewVisible && windowVisible && !rebooting && !!serverInfo,
    intervalMs: 10_000,
  });
  const { geo, loading: geoLoading } = useServerGeoIp({ host: state.host });

  // D-08 (Plan 07-06): the server IP is blurred by default and revealed only on
  // an explicit eye-toggle click — a shoulder-surfing privacy guard. Hidden is
  // the default on EVERY mount (state seeds false), so re-opening the panel never
  // leaves a previously-revealed IP in cleartext (session-only reveal, resets on
  // remount). This is a CSS-blur guard, not a secret-from-owner guard — the value
  // stays in the DOM and is NOT aria-hidden (a screen-reader owner may read it).
  const [ipRevealed, setIpRevealed] = useState(false);

  // D-07 (Plan 07-06): 60s fallback for the all-cards-loaded gate. If not all
  // cards settle within ~60s of mount, we render whatever IS ready rather than
  // hold the skeleton forever (the app must never look frozen on a slow card).
  // A single mount-scoped timer; cleared on unmount.
  const [fallbackElapsed, setFallbackElapsed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setFallbackElapsed(true), 60_000);
    return () => clearTimeout(id);
  }, []);

  // D-07 fix (post-UAT): monotonic latch for the all-cards gate. Once the gate
  // opens (all-ready OR the 60s fallback), it stays open for the lifetime of this
  // mount. Tying the gate directly to the live `*Loading` flags re-closed it on
  // every periodic poll refetch within the first 60s, flashing the whole grid back
  // to the skeleton. The latch makes the gate a true first-load-only gate.
  const gateOpenedRef = useRef(false);

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

  // H-01 / SAFETY-02 (Plan 04-14): destructure the exact fields server_get_uptime
  // needs so we forward ONLY those — not the whole sshParams object (which has a
  // `[key: string]: unknown` index signature and carries the plaintext password).
  // Spreading the full object leaked the password into every uptime poll's IPC
  // args. Mirrors the primitive-destructure pattern in useServerStats.ts.
  const {
    host: uptimeHost,
    port: uptimePort,
    user: uptimeUser,
    password: uptimePassword,
    keyPath: uptimeKeyPath,
  } = sshParams;

  useEffect(() => {
    // E-2 (Plan 09-19): when the protocol is stopped / rebooting / the tab is
    // hidden, CLEAR the frozen fastUptime so the Uptime card falls through to
    // stats/skeleton/«—» instead of showing a stale value forever. The pre-fix
    // effect only early-returned (leaving the last value frozen on screen after
    // a stop).
    if (!serverInfo?.serviceActive || rebooting || !isOverviewVisible) {
      setFastUptime(null);
      return;
    }
    let cancelled = false;
    // QE-01 (Plan 09-19): uptime is a ONE-SHOT on mount (fast first paint —
    // `cat /proc/uptime` returns in <100ms, so the card appears almost instantly
    // without waiting for the ~2s stats poll). The recurring `setInterval` was
    // dropped: the 10s `useServerStats` poll already returns `uptime_seconds` and
    // owns steady-state, so the standalone interval was a duplicate SSH poll.
    invoke<{ uptime_seconds: number }>("server_get_uptime", {
      host: uptimeHost,
      port: uptimePort,
      user: uptimeUser,
      password: uptimePassword,
      keyPath: uptimeKeyPath,
    })
      .then((r) => { if (!cancelled) setFastUptime(r.uptime_seconds); })
      .catch(() => { /* silent — stats fallback handles display */ });
    return () => { cancelled = true; };
    // H-01 / SAFETY-02 (Plan 04-14): depend on the primitive SSH fields the
    // one-shot actually forwards, NOT the whole sshParams object — we pass only
    // { host, port, user, password, keyPath }, so the password is never spread
    // into extra IPC arg keys (mirrors useServerStats).
  }, [uptimeHost, uptimePort, uptimeUser, uptimePassword, uptimeKeyPath, serverInfo?.serviceActive, rebooting, isOverviewVisible]);

  // ── Security status (firewall + fail2ban) — on-demand, не polling ──
  const [security, setSecurity] = useState<{ firewall: { installed: boolean; active: boolean }; fail2ban: { installed: boolean; active: boolean } } | null>(null);
  const [securityLoading, setSecurityLoading] = useState(false);
  // post-UAT: the D-07 gate must wait for security to have actually SETTLED (its
  // first fetch finished), NOT merely `!securityLoading`. That flag inits `false`
  // and the fetch is kicked off in an effect AFTER first render — so the gate could
  // open before security even started, and the Security card then flashed its
  // skeleton AFTER the general skeleton. Flipped true in refetchSecurity's .finally().
  const [securityHasSettled, setSecurityHasSettled] = useState(false);

  // UAT 2026-05-23 revision: refresh strategy is now event-driven only.
  // Previously this card re-fetched on every flip of `isOverviewVisible`
  // (i.e. every Overview tab visit), which the user reported as
  // unnecessary churn — firewall / fail2ban / SSH-key state doesn't
  // change behind the back of this app. The window listener for
  // 'tt:security-changed' (below) is the canonical source of refresh
  // signals; SecuritySection / FirewallModal / Fail2banModal dispatch
  // it after every toggle. Tab switches no longer cause a refetch.
  //
  // C-01 (Plan 04-14): refetchSecurity is now a `useCallback` that depends on
  // the primitive SSH fields (host/port/user/password/keyPath) + serviceActive +
  // rebooting — exactly like useSecurityState.load. Pre-fix it was a plain
  // function re-created every render, and the two effects below suppressed it
  // from their deps via a MISLEADING "ref-like pattern" eslint-disable comment
  // (no ref existed). That meant a NON-host SSH change (e.g. a port change) left
  // the window-listener closure stale, refetching with the OLD port. The
  // memoized form makes the listener genuinely re-bind on every primitive change.
  const securityHost = sshParams.host;
  const securityPort = sshParams.port;
  const securityUser = sshParams.user;
  const securityPassword = sshParams.password;
  const securityKeyPath = sshParams.keyPath;
  const serviceActive = serverInfo?.serviceActive;
  const refetchSecurity = useCallback(() => {
    // Round-3 re-UAT fix: firewall (ufw) + fail2ban are SERVER-side services whose
    // status is INDEPENDENT of whether the VPN protocol is running. Gating this
    // fetch on `serviceActive` left the Overview «Безопасность» card showing «—»
    // for both while the protocol was stopped (and after a re-auth) even though
    // the Security tab loaded them fine. Only skip while `rebooting` (SSH unstable).
    // `serviceActive` stays in the deps/sig below so the card refreshes on start↔stop.
    if (rebooting) return;
    setSecurityLoading(true);
    invoke<{ firewall: { installed: boolean; active: boolean }; fail2ban: { installed: boolean; active: boolean } }>(
      "security_get_status",
      { host: securityHost, port: securityPort, user: securityUser, password: securityPassword, keyPath: securityKeyPath },
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
      .finally(() => { setSecurityLoading(false); setSecurityHasSettled(true); });
    // serviceActive intentionally NOT a dep: the fetch no longer branches on it
    // (firewall/fail2ban are protocol-independent). The sig-effect below keeps
    // serviceActive so the card still refreshes on a start↔stop transition.
  }, [securityHost, securityPort, securityUser, securityPassword, securityKeyPath, rebooting, activityLog]);

  // C-01: StrictMode-safe single-fire. The dev double-mount would otherwise fire
  // security_get_status twice on the same SSH channel. A signature ref ensures
  // the initial fetch runs exactly once per unique param set, surviving the
  // mount→cleanup→remount cycle (same approach as the Phase-2 listener guards).
  const securityFetchedSigRef = useRef<string | null>(null);
  useEffect(() => {
    const sig = `${securityHost}|${securityPort}|${securityUser}|${securityPassword}|${securityKeyPath}|${serviceActive}|${rebooting}`;
    if (securityFetchedSigRef.current === sig) return;
    securityFetchedSigRef.current = sig;
    refetchSecurity();
  }, [refetchSecurity, securityHost, securityPort, securityUser, securityPassword, securityKeyPath, serviceActive, rebooting]);

  // Listen to cross-component «security state changed» events from
  // SecuritySection / FirewallModal / Fail2banModal. Even when user is
  // на Overview tab while change happens (rare — but defensive). The handler
  // now depends on the memoized refetchSecurity, so it always re-binds to the
  // current closure (no stale-port bug).
  useEffect(() => {
    const handler = () => refetchSecurity();
    window.addEventListener("tt:security-changed", handler);
    return () => window.removeEventListener("tt:security-changed", handler);
  }, [refetchSecurity]);

  // ── Initial ping ──
  useEffect(() => {
    if (!serverInfo?.serviceActive) { setPing(null); return; }
    invoke<number>("ping_endpoint", { host: state.host, port: 443 })
      .then((ms) => setPing(ms))
      .catch(() => setPing(-1));
  }, [state.host, serverInfo?.serviceActive]);

  // ── Background health check: ping every 30s ──
  // QE-05 (Plan 09-19): gate on `windowVisible` so the 30s ping pauses while the
  // window is hidden (resumes on visibilitychange — the effect re-runs because
  // windowVisible is a dep). Saves a needless ping the user can't see anyway.
  useEffect(() => {
    if (!serverInfo?.serviceActive || rebooting || !windowVisible) return;
    healthPollRef.current = setInterval(() => {
      invoke<number>("ping_endpoint", { host: state.host, port: 443 })
        .then((ms) => setPing(ms))
        .catch(() => setPing(-1));
    }, 30000);
    return () => { if (healthPollRef.current) clearInterval(healthPollRef.current); };
  }, [state.host, serverInfo?.serviceActive, rebooting, windowVisible]);

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
    activityLog,
  });
  rebootRefs.current = {
    sshParams,
    host: state.host,
    setRebooting,
    setServerInfo,
    t,
    pushSuccess: state.pushSuccess,
    activityLog,
  };

  useEffect(() => {
    if (!rebooting) return;
    // QE-05 exception (Plan 09-19): the reboot poller intentionally does NOT gate
    // on `windowVisible`. The server may finish rebooting while the window is
    // minimized; gating this poll would stall recovery detection and leave the
    // panel stuck on the rebooting spinner until the user re-focuses. Every other
    // Overview interval poller pauses when hidden — this one must not.
    let elapsed = 0;
    // WR-04: a local `done` flag + immediate clearInterval on the
    // success/timeout branch. Previously the success branch called
    // setRebooting(false) while the interval was still registered; clearInterval
    // only ran on the next effect re-run / unmount, so between setRebooting(false)
    // and React committing the teardown the interval body (incl. the ping_endpoint
    // follow-up) could fire again, and a fast true→false→true toggle could leave
    // two intervals briefly coexisting — the "SSH-storm on wake" the comment
    // warns about. We now stop the loop synchronously and early-return if `done`.
    let done = false;
    const interval = setInterval(async () => {
      if (done) return;
      elapsed += 10;
      setRebootCountdown(elapsed);
      const refs = rebootRefs.current;
      try {
        const info = await invoke<{ installed: boolean; version: string; serviceActive: boolean; users: string[] }>(
          "check_server_installation", refs.sshParams
        );
        if (info) {
          done = true;
          clearInterval(interval);
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
          done = true;
          clearInterval(interval);
          refs.setRebooting(false);
          setRebootCountdown(0);
          // C-02 (Plan 04-14): surface an HONEST error when the reboot poll
          // exceeds 120s (a slow OVH/Hetzner reboot can take that long). The
          // user sees an error toast + an ERROR activity-log entry so the
          // panel returning to idle is explained rather than mysterious.
          //
          // D-06 (Plan 07-05): plain unreachability/timeout must NOT wipe
          // stored credentials. The old `clear_ssh_credentials` call here was
          // an auto-logout that made a transient reboot delay look like a
          // permanent disconnect — the user had to re-enter SSH data for a
          // server that was merely slow to wake. The ONLY credential-clear path
          // is now the DELIBERATE handleDisconnect in
          // useControlPanelOrchestrator. We keep the toast/log/refresh-signal so
          // the panel still reacts honestly, just without dropping the creds.
          refs.pushSuccess(refs.t("server.overview.rebootTimeout"), "error");
          refs.activityLog(
            "ERROR",
            "overview.reboot.timeout server unreachable after 120s",
            "check_server_installation",
          );
          localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());
        }
      }
    }, 10000);
    return () => { done = true; clearInterval(interval); };
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
    return <OverviewSkeleton t={t} refreshAriaLabel={refreshAriaLabel} />;
  }

  // ── D-07 (Plan 07-06): all-cards-loaded gate (+60s fallback) ──
  // The panel must NEVER look broken because one card is slow. Render the full
  // skeleton until EVERY async per-card signal is SETTLED (success OR failure —
  // RESEARCH Pitfall 4), then swap to the real grid in one go (no per-card
  // progressive flash). "settled" — not "succeeded" — is critical: a genuinely
  // down card (ping=-1, a geo error, a stats failure) counts as ready, so a
  // permanently-failing card does NOT hold the skeleton for the full 60s.
  //
  // The async signals we wait on (others derive from `serverInfo`, already
  // present here, so they are ready by construction):
  //   • ping     — settled once `ping !== null` (a number, or -1 on failure)
  //   • geo      — settled once `!geoLoading`
  //   • stats    — settled once `!statsLoading` (drives Load + the Uptime fallback)
  //   • security — settled once `!securityLoading`
  // Speed is on-demand (never auto-loads) so it is NOT a gate signal.
  //
  // Crucial: ping is only a *pending* signal while the protocol is RUNNING and not
  // rebooting. When the protocol is stopped the ping effect deliberately sets
  // `ping = null` (it is "n/a", not "loading"), so we must NOT wait on it then —
  // otherwise a stopped server would hold the skeleton until the 60s fallback.
  // While rebooting we also don't gate on ping (the Status card shows its own
  // rebooting spinner regardless). `fallbackElapsed` is flipped by a 60s timer
  // below; once either all-ready or the fallback fires, the gate opens and stays
  // open for this mount.
  const pingSettled = !serverInfo.serviceActive || rebooting || ping !== null;
  // security is "settled" once its first fetch completes (.finally sets the flag),
  // OR when the service is stopped/rebooting (refetchSecurity early-returns then, so
  // it never fetches — gating on it would hang the panel until the 60s fallback).
  // Using `!securityLoading` was wrong: it inits true-equivalent (!false) before the
  // fetch starts, so the gate could open before security loaded (skeleton flash).
  const securitySettled = !serverInfo.serviceActive || rebooting || securityHasSettled;
  const allReady = pingSettled && !geoLoading && !statsLoading && securitySettled;

  // Gate: hold the full skeleton until all-ready OR the 60s fallback fires, then
  // LATCH open. Reuses OverviewSkeleton verbatim — no new loading visual (D-07
  // contract). The latch (gateOpenedRef) is the post-UAT fix: without it, a
  // periodic poll refetch (stats/geo/security toggling its *Loading flag) flipped
  // `allReady` back to false within the 60s window and re-rendered the whole grid
  // as the skeleton — a synchronized full-grid flash every poll cycle. Once opened,
  // the gate never re-closes for this mount; later refetches update cards in place.
  if (allReady || fallbackElapsed) {
    gateOpenedRef.current = true;
  }
  if (!gateOpenedRef.current) {
    return <OverviewSkeleton t={t} refreshAriaLabel={refreshAriaLabel} />;
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

  // TLS expiry calculation (3 states: >14d green, 7-14d warning, ≤7d danger).
  // certInfo is computed BEFORE hasTls because hasTls is now readability-gated
  // on the parsed cert (UAT-6 reorder).
  const certInfo = state.certRaw ? parseCertInfo(state.certRaw) : null;
  // UAT-6: hasTls was `!!state.certRaw` — but a missing/unreadable cert can still
  // arrive as a certRaw payload (the SSH probe returned *something*) with an empty
  // notAfter, which painted the tile green «Активен». Gate hasTls on notAfter
  // readability: with no readable expiry the not-hasTls arm paints the neutral
  // placeholder dash. Valid LE certs have a non-empty notAfter → unaffected.
  const hasTls = !!certInfo?.notAfter;
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
        {/* R4-F01: bound the Status content to the skeleton's height hint (h:56)
            and vertically center it. The EcgSvg is a fixed 36px-tall SVG; without
            a bounded, centered envelope the ECG + label stack drifted taller than
            the other Row-1 cards, ballooning the «Статус протокола» card. minHeight
            (not a hard height) keeps the rebooting spinner branch — slightly taller
            — from clipping while still capping the steady ECG state. */}
        {rebooting ? (
          <div className="flex flex-col items-center justify-center gap-1.5" style={{ minHeight: 56 }}>
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--color-warning-500)" }} />
            <span className="text-sm" style={{ color: "var(--color-warning-500)" }}>
              {t("server.overview.rebootingCountdown")}{rebootCountdown > 0 ? ` ${rebootCountdown}s` : "..."}
            </span>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-1.5" style={{ minHeight: 56 }}>
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

      {/* Ping — refresh скрыт когда протокол off (UAT consistency со Speed карточкой).
          Width rule: compact 140px basis for the normal "45 ms" value; widens to
          ERROR_CARD_MIN_BASIS in the error state so the 2-line caption fits (see
          the ERROR_CARD_MIN_BASIS note above — keeps Ping & Speed consistent). */}
      <Card padding="md" style={{ flex: ping === -1 ? `1 1 ${ERROR_CARD_MIN_BASIS}px` : "1 1 140px" }}>
        <Title
          icon={<Activity className="w-5 h-5" />}
          text={t("server.overview.cards.ping")}
          onRefresh={isRunning && !rebooting ? refreshPing : undefined}
          refreshing={pingLoading}
          refreshAriaLabel={refreshAriaLabel}
        />
        {/* M-07: если ping упал (setPing(-1)) — прочерк + приписка
            «Не удалось получить данные». В pending state (null) тоже
            прочерк, но без приписки. Refresh button в Title (выше)
            перезапускает measurement.
            R4-F01: bound the value area to the skeleton's height hint (h:48) and
            vertically center it (matches the Speed card's minHeight:48 empty/error
            state). Без minHeight прочерк (32px) + длинная приписка раздували карточку
            намного выше остальных карточек первого ряда. */}
        <div className="flex flex-col items-center justify-center gap-0.5" style={{ minHeight: 48 }}>
          {ping !== null && ping > 0 ? (
            <div className="flex items-baseline justify-center gap-1">
              <span className="font-mono whitespace-nowrap" style={{ ...bigNum, color: pingColor }}>{ping}</span>
              <span className="text-sm font-mono whitespace-nowrap" style={muted}>ms</span>
            </div>
          ) : (
            <>
              <span className="font-mono" style={{ ...bigNum, ...muted }}>—</span>
              {ping === -1 && (
                // Error caption rule (owner UAT): show the FULL «Не удалось
                // получить данные…» text and let it wrap freely — NO line cap, NO
                // truncation/ellipsis. The card is wide enough (ERROR_CARD_MIN_BASIS)
                // that this lands in 2 lines at the normal width; on a narrower
                // window it simply wraps to 3–4 lines and the card grows taller
                // (minHeight is a floor, not a ceiling). Nothing is ever clipped.
                <span className="text-xs text-center max-w-full" style={muted}>
                  {t("server.overview.dataUnavailable")}
                </span>
              )}
            </>
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
                <span className="font-mono" style={bigNum}>{Math.round(speed.download_mbps)}</span>
                <span className="text-sm whitespace-nowrap font-mono" style={muted}>{t("server.overview.speedUnit")}</span>
              </div>
            </div>
            <div className="h-7 shrink-0" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
            <div className="flex items-center gap-1.5" style={{ minWidth: 100 }}>
              <ArrowUp className="w-6 h-6 shrink-0" style={{ color: "var(--color-warning-500)" }} />
              <div className="flex items-baseline gap-1">
                <span className="font-mono" style={bigNum}>{Math.round(speed.upload_mbps)}</span>
                <span className="text-sm whitespace-nowrap font-mono" style={muted}>{t("server.overview.speedUnit")}</span>
              </div>
            </div>
          </div>
        ) : speedFailed ? (
          /* M-08: прочерк + приписка «Не удалось получить данные».
             Refresh в Title перезапустит speedtest_run. */
          <div className="flex flex-col items-center justify-center gap-0.5 py-2" style={{ minHeight: 48 }}>
            <span className="font-mono" style={{ ...bigNum, ...muted }}>—</span>
            {/* Error caption rule (unified with the Ping card): centered, full text,
                wraps freely — NO line cap, NO ellipsis. The Speed card's 280px basis
                lands it in 2 lines at the normal width; narrower just wraps taller. */}
            <span className="text-xs text-center max-w-full" style={muted}>
              {t("server.overview.dataUnavailable")}
            </span>
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
          {/* R2-F08 (Plan 09-37): while the user count is not yet authoritatively
              known (silent cold-start race — serverInfo.users:[] before the real
              probe ran), show the EXACT loading skeleton OverviewSkeleton uses for
              this card (:192) instead of the digit 0. A populated/non-silent-settled
              load flips usersKnown, after which 0 is a CONFIRMED zero, not the race.
              This sentinel lives strictly inside the Users-card value branch, AFTER
              the D-07 all-cards gate has already opened — it does NOT feed
              allReady/gateOpenedRef. See 09-UAT-2-DIAGNOSIS.md (R2-F08). */}
          {usersKnown ? (
            <span className="font-mono whitespace-nowrap" style={userCount > 0 ? bigNum : { ...bigNum, ...muted }}>{userCount}</span>
          ) : (
            <Skeleton variant="line" width={100} height={32} data-testid="users-count-skeleton" />
          )}
        </div>
      </ClickableCard>

      {/* ── Row 2: IP | Country | Uptime | Version ── */}

      {/* IP / Сервер — CONTROL-PANEL-SPEC §4.1: «Сервер» card.
          UAT 2026-05-20: Restart Service removed entirely (not needed in Overview). */}
      <Card padding="md" style={{ flex: "1 1 240px" }}>
        <Title
          icon={<Network className="w-5 h-5" />}
          text={t("server.overview.cards.ip")}
          refreshAriaLabel={refreshAriaLabel}
          action={
            // D-08: Eye/EyeOff toggle. EyeOff = currently hidden (click to reveal),
            // Eye = currently revealed (click to hide). w-4 h-4 matches the refresh
            // icon size. aria-label reflects the ACTION the click performs, so AT
            // users hear «Показать…»/«Скрыть…» — the actual outcome, not the state.
            <IconButton
              icon={ipRevealed ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              aria-label={t(ipRevealed ? "server.overview.ip.hide" : "server.overview.ip.show")}
              onClick={() => setIpRevealed((v) => !v)}
            />
          }
        />
        <div className="flex items-center justify-center py-2">
          {/* IP masking: when hidden the address is NOT rendered (opacity 0) and an animated dust
              field (IpDustOverlay) covers it; revealing CROSS-FADES the value IN as the dust fades
              OUT (400ms ease-out). The dust is sized to the ADDRESS, not the whole card — a relative
              inline-block wrapper sized to the value, with the dust as its absolute inset-0 child.
              Replaced the old blur(6px) (readable silhouette + hard halo edge). The value reserves
              its width in both states → no layout shift on toggle. */}
          <span className="relative inline-block whitespace-nowrap" style={bigNum}>
            <span
              className="font-mono whitespace-nowrap"
              style={{
                opacity: ipRevealed ? 1 : 0,
                transition: "opacity 400ms var(--ease-out)",
                // While hidden the value is transparent but still occupies its box, and the dust
                // canvas above is pointer-events:none — so a hover lands on this text and the UA
                // paints a text/I-beam cursor over the invisible characters. Suppress it (default
                // arrow + no text selection) while masked; revealed → normal selectable IP for copy.
                cursor: ipRevealed ? undefined : "default",
                userSelect: ipRevealed ? undefined : "none",
              }}
            >
              {state.host || "—"}
            </span>
            <span
              className="absolute inset-0"
              style={{ opacity: ipRevealed ? 0 : 1, transition: "opacity 400ms var(--ease-out)", pointerEvents: "none" }}
            >
              <IpDustOverlay active={!ipRevealed} />
            </span>
          </span>
        </div>
      </Card>

      {/* Country — live (D-05) */}
      <Card padding="md" style={{ flex: "1 1 180px" }}>
        <Title icon={<Globe className="w-5 h-5" />} text={t("server.overview.cards.country")} refreshAriaLabel={refreshAriaLabel} />
        <div className="flex items-center justify-center py-2">
          {geoLoading ? (
            <Skeleton variant="line" width={120} height={28} />
          ) : geo ? (
            <span style={countryValue} className="flex items-center gap-2 min-w-0" data-testid="country-card-value">
              {/* M-06: ipwho.is возвращает готовый emoji флаг (U+1F1XX regional
                  indicators). Показываем его слева от страны — проще, чем
                  тянуть SVG-флаги из flag-icons или подобного пакета. Emoji
                  рендерится через system font на Windows 11 (Segoe UI Emoji). */}
              {geo.flag_emoji && (
                <span
                  aria-hidden="true"
                  className="text-xl leading-none shrink-0"
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
              {/* CP-2 (16-09): whitespace-nowrap keeps the localized name on ONE
                  line; truncate + title degrades a pathologically long name to a
                  «…» ellipsis with the full name on hover instead of wrapping. */}
              {(() => {
                const localized = getLocalizedCountry(geo.country_code, geo.country, i18n.language);
                return (
                  <span className="whitespace-nowrap truncate leading-tight" title={localized}>
                    {localized}
                  </span>
                );
              })()}
            </span>
          ) : (
            <span className="text-xl font-semibold" style={muted}>—</span>
          )}
        </div>
      </Card>

      {/* Uptime — the live 10s stats poll (stats.uptime_seconds) is AUTHORITATIVE and
          advances over the session. The one-shot server_get_uptime (<100ms) is only a
          FAST-FIRST-PAINT fallback shown until that first poll lands, so the card isn't
          blank for ~10s on open. (WR-04 10.1 review: prefer the live poll — fastUptime
          previously won for the whole mount, freezing the value at the open-time snapshot.) */}
      <Card padding="md" style={{ flex: "1 1 160px" }}>
        <Title icon={<Clock className="w-5 h-5" />} text={t("server.overview.cards.uptime")} refreshAriaLabel={refreshAriaLabel} />
        <div className="flex items-center justify-center py-2">
          {/* Uptime value rule (owner UAT, overrides D-09): NEVER wrap, NEVER
              truncate — show the value in full and let the card size to its
              content. whitespace-nowrap keeps it on one line; dropping
              overflow-hidden/text-ellipsis means the flex item's automatic
              min-width (= the value's intrinsic width) floors the card, so it
              grows to fit instead of clipping to «…». Realistic values stay short
              ("128д 19ч"), so this never blows up a row. */}
          {stats ? (
            <span className="font-mono whitespace-nowrap" style={bigNum}>{formatServerUptime(stats.uptime_seconds, t)}</span>
          ) : fastUptime !== null ? (
            <span className="font-mono whitespace-nowrap" style={bigNum}>{formatServerUptime(fastUptime, t)}</span>
          ) : statsLoading ? (
            <Skeleton variant="line" width={80} height={28} />
          ) : (
            <span className="font-mono" style={{ ...bigNum, ...muted }}>—</span>
          )}
        </div>
      </Card>

      {/* Protocol version — drill-down (D-11). Phase 19: target is «Сервис» tab
          (was «Конфигурация» — bug fix per UI-SPEC §Block 3 §B). ArrowUp icon
          appears next to the version when `sidecarAvailable` is truthy
          (warning-500 colour, matches «Доступно новое обновление» Badge tone). */}
      <ClickableCard
        style={{ flex: "1 1 220px" }}
        onClick={() => onNavigate?.("service")}
        ariaLabel={t("server.overview.cards.protocolVersion")}
      >
        <Title icon={<Package className="w-5 h-5" />} text={t("server.overview.cards.protocolVersion")} clickable refreshAriaLabel={refreshAriaLabel} />
        <div className="flex items-center justify-center gap-3 py-2">
          <span className="font-mono whitespace-nowrap" style={bigNum}>{version}</span>
          {sidecarAvailable && (
            // Phase 19: дизайн-спека (Storybook «8b. Версия — обновление»)
            // предписывает `ArrowUpCircle` w-6 h-6 warning-500 — стрелка в
            // круглой обводке, как пиктограмма уведомления. Раньше тут была
            // голая `ArrowUp` без круга — мискомпонент vs спека.
            <ArrowUpCircle
              className="w-6 h-6 shrink-0"
              style={{ color: "var(--color-warning-500)" }}
              aria-label={t("server.service.protocol.update_available_badge")}
              data-testid="overview-protocol-update-arrow"
            />
          )}
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
        {/* P UAT 2026-05-04: Skeleton рендерится на ЛЮБОЙ securityLoading
            (initial + refetch после tt:security-changed event), не только когда
            security===null. Раньше после change в Security tab Overview показывал
            stale state до завершения refetch — user видел «Активен» когда фактически
            firewall уже был выключен. Теперь Skeleton покрывает window между
            event dispatch и refetch completion. 3 cards: firewall+fail2ban+tls
            (Phase 16 ssh-key card удалён). */}
        {securityLoading ? (
          <div className="grid grid-cols-2 gap-2 mt-1">
            {[1, 2, 3].map((i) => (
              <div key={i} data-testid="security-skeleton-tile" className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
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
            { name: t("server.overview.security.tls"), ok: hasTls, label: tlsLabel, tone: tlsState },
          ].map((item) => {
            // tone — explicit 3-state (ok/warning/danger) for TLS; ok — boolean for firewall/fail2ban.
            // E-1 (Plan 09-19): the TLS sub-tile supplies an EXPLICIT 3-state
            // `tone` (ok/warning/danger/null). The old `item.tone ?? (...)` form
            // swallowed an explicit `null` tone (no-cert → tlsState=null) and
            // fell through to the boolean fallback `item.ok===false → "danger"`,
            // painting a no-cert TLS tile red «Истёк». Distinguish "tone key
            // present" (TLS — use it verbatim, even when null → neutral) from
            // "no tone supplied" (firewall/fail2ban — derive from item.ok).
            const hasExplicitTone = "tone" in item;
            const tone = hasExplicitTone
              ? (item as { tone?: "ok" | "warning" | "danger" | null }).tone ?? null
              : item.ok === null ? null : item.ok ? "ok" : "danger";
            // tone-conveying attr for a class-free test assertion (D-04). A null
            // tone surfaces as "neutral" so a no-cert TLS tile is provably not
            // danger. The TLS tile also gets a stable data-testid for scoping.
            const dataTone = tone ?? "neutral";
            const isTls = item.name === t("server.overview.security.tls");
            const bg = tone === null
              ? "var(--color-bg-elevated)"
              : tone === "ok"
                ? "var(--color-status-connected-bg)"
                : tone === "warning"
                  ? "var(--color-status-connecting-bg)"
                  : "var(--color-status-error-bg)";
            const color = tone === null
              ? "var(--color-text-muted)"
              : tone === "ok"
                ? "var(--color-success-500)"
                : tone === "warning"
                  ? "var(--color-warning-500)"
                  : "var(--color-danger-500)";
            return (
              <div
                key={item.name}
                className="rounded-[var(--radius-md)] px-3 py-2"
                style={{ backgroundColor: bg }}
                data-tone={dataTone}
                data-testid={isTls ? "tls-tile" : undefined}
              >
                <div className="text-sm font-semibold" style={primary}>{item.name}</div>
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
        <div className="space-y-2 mt-1">
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
                    <span className="text-sm font-semibold font-mono tabular-nums" style={primary}>{Math.round(stats.cpu_percent)}%</span>
                  ) : (
                    <span className="text-sm font-mono" style={muted}>—</span>
                  )}
                </div>
                <ProgressBar value={stats ? Math.min(100, Math.max(0, stats.cpu_percent)) : 0} size="sm" color="success" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm" style={muted}>RAM</span>
                  {stats && stats.mem_total > 0 ? (
                    <span className="text-sm font-semibold font-mono tabular-nums" style={primary}>
                      {Math.round(stats.mem_used / 1024 / 1024)} / {Math.round(stats.mem_total / 1024 / 1024)} {t("server.overview.ramUnit")}
                    </span>
                  ) : (
                    <span className="text-sm font-mono" style={muted}>—</span>
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
