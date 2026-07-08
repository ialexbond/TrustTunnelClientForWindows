import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Shield, ShieldAlert } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { Skeleton } from "../../shared/ui/Skeleton";
import type { ServerState } from "./useServerState";
import { useSecurityState, FAIL2BAN_PRESETS, type Fail2banPresetId } from "./useSecurityState";
import { durationsEqual } from "./fail2banUtils";
import { pluralRu } from "../../shared/lib/pluralRu";
import { CertSection } from "./CertSection";
import { FirewallModal } from "./FirewallModal";
import { Fail2banModal } from "./Fail2banModal";

/**
 * P UAT 2026-04-30 — Skeleton placeholder для card во время initial load.
 * Mimics card grid (icon + title + status + subtitle + action button).
 */
function SecurityCardSkeleton({ testId }: { testId: string }) {
  return (
    <Card data-testid={testId}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Skeleton variant="circle" width={20} height={20} rounded />
          <div className="flex-1 min-w-0 space-y-2">
            <Skeleton variant="line" height={14} width="40%" />
            <Skeleton variant="line" height={12} width="70%" />
          </div>
        </div>
        <Skeleton variant="card" height={32} width={96} />
      </div>
    </Card>
  );
}

interface Props {
  state: ServerState;
}

/**
 * Phase 16 Plan 05 — SecuritySection 4-cards layout (D-7.x).
 *
 * Replaces the legacy SecuritySection (~50 lines wrapping Fail2banSection +
 * FirewallSection inline) с целевым стейтом по CONTROL-PANEL-SPEC.md §4.5:
 *
 *   ┌──────────────────────────────────┐
 *   │  Firewall   • Активен  [Настроить]│
 *   ├──────────────────────────────────┤
 *   │  Fail2Ban   • Активен  [Настроить]│
 *   ├──────────────────────────────────┤
 *   │  SSH-ключ   • Сгенерирован [Настроить]│
 *   ├──────────────────────────────────┤
 *   │  TLS Сертификат — full inline UI │
 *   │  (CertSection extended fields +  │
 *   │   auto-renewal toggle)           │
 *   └──────────────────────────────────┘
 *
 * Each summary card:
 *   - Icon (Shield / ShieldAlert / KeyRound) в accent-interactive color.
 *   - Title (text-subtitle) + StatusIndicator dot.
 *   - Subtitle с status text — "Защита от brute-force — Активен".
 *   - "Настроить" CTA (variant=secondary) → opens corresponding Modal.
 *
 * 4th block — `<CertSection state={state} security={security} />` — extended
 * с SHA256/CN/Issuer/notBefore + auto-renewal toggle (Plan 16-05 Task 2).
 *
 * Modals managed at top level (T-03 — `isOpen` passed as-is, NEVER early-return
 * null). Each Modal owns own mount/animating lifecycle через Modal primitive.
 *
 * Single `useSecurityState` instance — shared между Modals + CertSection so
 * that `certbotTimerStatus` snapshot stays consistent across the tab.
 *
 * R-9 invariant: SecurityStatus shape consumed by OverviewSection security
 * summary block (`firewall.{installed,active}`, `fail2ban.{installed,active}`)
 * is preserved — Phase 16 only adds optional ssh_key + cert fields.
 */
export function SecuritySection({ state }: Props) {
  const { t, i18n } = useTranslation();
  const security = useSecurityState(state.sshParams, state.pushSuccess, state.onPortChanged);

  const [firewallOpen, setFirewallOpen] = useState(false);
  const [fail2banOpen, setFail2banOpen] = useState(false);

  const fwInstalled = security.status?.firewall.installed ?? false;
  const fwActive = security.status?.firewall.active ?? false;
  const fwRulesCount = security.status?.firewall.rules.length ?? 0;
  const f2bInstalled = security.status?.fail2ban.installed ?? false;
  const f2bActive = security.status?.fail2ban.active ?? false;
  const sshdJail = security.status?.fail2ban.jails.find((j) => j.name === "sshd");

  const fwStatusText = !fwInstalled
    ? t("server.security.summary.status_not_installed")
    : fwActive
      ? t("server.security.summary.status_active")
      : t("server.security.summary.status_inactive");

  const f2bStatusText = !f2bInstalled
    ? t("server.security.summary.status_not_installed")
    : f2bActive
      ? t("server.security.summary.status_active")
      : t("server.security.summary.status_inactive");

  // P0-5 #1 — informative subtitles с реальными данными вместо пустых
  // «Защита от brute-force — Активен» (status дублирует StatusIndicator dot).
  // Каждая card теперь несёт UNIQUE info которая иначе требует open Modal.
  const fwSubtitle = useMemo(() => {
    if (!fwInstalled) return t("server.security.summary.firewall_subtitle_not_installed");
    if (!fwActive) return t("server.security.summary.firewall_subtitle_inactive");
    // P UAT 2026-05-04: pluralization fix — было «3 правил» (wrong),
    // стало «3 правила» (proper Russian plural). EN использует i18next
    // built-in count pluralization через keys *_one/_other.
    const rulesText = i18n.language === "ru"
      ? pluralRu(fwRulesCount, "правило", "правила", "правил")
      : t("server.security.summary.firewall_subtitle_active_rules", { count: fwRulesCount });
    return rulesText;
  }, [fwInstalled, fwActive, fwRulesCount, i18n.language, t]);

  const f2bSubtitle = useMemo(() => {
    if (!f2bInstalled) return t("server.security.summary.fail2ban_subtitle_not_installed");
    if (!f2bActive) return t("server.security.summary.fail2ban_subtitle_inactive");
    if (!sshdJail) return t("server.security.summary.fail2ban_subtitle_no_jail");
    // BUG-01 fix: durationsEqual нормализует "1h" ↔ "3600" перед сравнением
    // (mirror Fail2banSettingsTab.detectedPreset logic).
    const matched = Object.entries(FAIL2BAN_PRESETS).find(
      ([, cfg]) =>
        cfg.maxretry === sshdJail.maxretry &&
        durationsEqual(cfg.bantime, sshdJail.bantime) &&
        durationsEqual(cfg.findtime, sshdJail.findtime),
    );
    const presetId = matched ? (matched[0] as Fail2banPresetId) : "custom";
    const presetName = t(`server.security.fail2ban.presets.${presetId}`);
    return t("server.security.summary.fail2ban_subtitle_active", {
      preset: presetName,
      retries: sshdJail.maxretry,
    });
  }, [f2bInstalled, f2bActive, sshdJail, t]);

  // P UAT 2026-04-30 — Show Skeleton placeholders во время initial fetch
  // (security.loading && нет ещё status snapshot). Subsequent refresh не
  // показывает Skeleton — это flicker от polling/refresh.
  const isInitialLoading = security.loading && !security.status;
  if (isInitialLoading) {
    return (
      <div aria-live="polite" className="space-y-3" data-testid="security-section-loading">
        <SecurityCardSkeleton testId="firewall-card-skeleton" />
        <SecurityCardSkeleton testId="fail2ban-card-skeleton" />
        <SecurityCardSkeleton testId="cert-card-skeleton" />
      </div>
    );
  }

  return (
    <div aria-live="polite" className="space-y-3" data-testid="security-section">
      {/* Card 1 — Firewall summary (opens FirewallModal) */}
      <Card data-testid="firewall-summary-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <Shield
              className="w-5 h-5 shrink-0"
              style={{ color: "var(--color-accent-interactive)" }}
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-subtitle">{t("server.security.summary.firewall_card_title")}</h3>
                {/* P2-17 #X — not-installed = danger (nudges install) */}
                <StatusIndicator
                  status={fwInstalled && fwActive ? "success" : fwInstalled ? "warning" : "danger"}
                  size="sm"
                  label={fwStatusText}
                />
              </div>
              <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
                {fwSubtitle}
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setFirewallOpen(true)}
            data-testid="firewall-configure-button"
          >
            {t("server.security.summary.configure_button")}
          </Button>
        </div>
      </Card>

      {/* Card 2 — Fail2Ban summary (opens Fail2banModal) */}
      <Card data-testid="fail2ban-summary-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <ShieldAlert
              className="w-5 h-5 shrink-0"
              style={{ color: "var(--color-accent-interactive)" }}
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-subtitle">{t("server.security.summary.fail2ban_card_title")}</h3>
                {/* P2-17 #X — not-installed = danger */}
                <StatusIndicator
                  status={f2bInstalled && f2bActive ? "success" : f2bInstalled ? "warning" : "danger"}
                  size="sm"
                  label={f2bStatusText}
                />
              </div>
              <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
                {f2bSubtitle}
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setFail2banOpen(true)}
            data-testid="fail2ban-configure-button"
          >
            {t("server.security.summary.configure_button")}
          </Button>
        </div>
      </Card>

      {/* P UAT 2026-05-04: Card 3 «SSH-ключ» УДАЛЁН из UI per user request —
          фича работала плохо (false-positive uploads, lockout scenarios,
          contradictory status display). Backend commands остаются (могут
          вернуться в будущем после redesign). User управляет SSH auth через
          стандартный flow login form (password или manual .pem file). */}

      {/* Card 3 (was 4) — TLS Сертификат */}
      <CertSection state={state} security={security} />

      {/* Modals managed at top level (T-03 — isOpen passed as-is, NEVER
          early-return null in parent — Modal primitive owns 200ms exit anim). */}
      <FirewallModal
        isOpen={firewallOpen}
        onClose={() => setFirewallOpen(false)}
        state={security}
        onSecurityChanged={async () => {
          await security.load();
          // P UAT 2026-05-04 — broadcast event для cross-tab sync (Overview
          // listens). Без этого Overview видит stale state пока user не
          // переключится на него (visibility flip trigger).
          window.dispatchEvent(new CustomEvent("tt:security-changed"));
        }}
      />
      <Fail2banModal
        isOpen={fail2banOpen}
        onClose={() => setFail2banOpen(false)}
        state={security}
        sshParams={state.sshParams}
        onSecurityChanged={async () => {
          await security.load();
          // P UAT 2026-05-04 — broadcast event для cross-tab sync (Overview
          // listens). Без этого Overview видит stale state пока user не
          // переключится на него (visibility flip trigger).
          window.dispatchEvent(new CustomEvent("tt:security-changed"));
        }}
      />
    </div>
  );
}
