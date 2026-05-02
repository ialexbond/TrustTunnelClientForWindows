import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Shield, ShieldAlert, KeyRound } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import type { ServerState } from "./useServerState";
import { useSecurityState, FAIL2BAN_PRESETS, type Fail2banPresetId } from "./useSecurityState";
import { CertSection } from "./CertSection";
import { FirewallModal } from "./FirewallModal";
import { Fail2banModal } from "./Fail2banModal";
import { SshKeyModal } from "./SshKeyModal";

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
  const { t } = useTranslation();
  const security = useSecurityState(state.sshParams, state.pushSuccess, state.onPortChanged);

  const [firewallOpen, setFirewallOpen] = useState(false);
  const [fail2banOpen, setFail2banOpen] = useState(false);
  const [sshKeyOpen, setSshKeyOpen] = useState(false);

  const fwInstalled = security.status?.firewall.installed ?? false;
  const fwActive = security.status?.firewall.active ?? false;
  const fwRulesCount = security.status?.firewall.rules.length ?? 0;
  const fwSshPort = security.status?.firewall.current_ssh_port;
  const f2bInstalled = security.status?.fail2ban.installed ?? false;
  const f2bActive = security.status?.fail2ban.active ?? false;
  const sshdJail = security.status?.fail2ban.jails.find((j) => j.name === "sshd");
  const sshKeyGenerated = security.status?.ssh_key?.generated ?? false;
  const pwAuthDisabled = security.status?.ssh_key?.password_auth_disabled ?? false;

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

  const sshKeyStatusText = pwAuthDisabled
    ? t("server.security.ssh_key.status_pwauth_disabled")
    : sshKeyGenerated
      ? t("server.security.ssh_key.status_generated")
      : t("server.security.ssh_key.status_not_generated");

  // P0-5 #1 — informative subtitles с реальными данными вместо пустых
  // «Защита от brute-force — Активен» (status дублирует StatusIndicator dot).
  // Каждая card теперь несёт UNIQUE info которая иначе требует open Modal.
  const fwSubtitle = useMemo(() => {
    if (!fwInstalled) return t("server.security.summary.firewall_subtitle_not_installed");
    if (!fwActive) return t("server.security.summary.firewall_subtitle_inactive");
    return t("server.security.summary.firewall_subtitle_active", {
      count: fwRulesCount,
      port: fwSshPort ?? "?",
    });
  }, [fwInstalled, fwActive, fwRulesCount, fwSshPort, t]);

  const f2bSubtitle = useMemo(() => {
    if (!f2bInstalled) return t("server.security.summary.fail2ban_subtitle_not_installed");
    if (!f2bActive) return t("server.security.summary.fail2ban_subtitle_inactive");
    if (!sshdJail) return t("server.security.summary.fail2ban_subtitle_no_jail");
    // Detect preset matching jail config (mirror Fail2banSettingsTab logic).
    const matched = Object.entries(FAIL2BAN_PRESETS).find(
      ([, cfg]) =>
        cfg.maxretry === sshdJail.maxretry &&
        cfg.bantime === sshdJail.bantime &&
        cfg.findtime === sshdJail.findtime,
    );
    const presetId = matched ? (matched[0] as Fail2banPresetId) : "custom";
    const presetName = t(`server.security.fail2ban.presets.${presetId}`);
    return t("server.security.summary.fail2ban_subtitle_active", {
      preset: presetName,
      retries: sshdJail.maxretry,
    });
  }, [f2bInstalled, f2bActive, sshdJail, t]);

  const sshKeySubtitle = useMemo(() => {
    if (!sshKeyGenerated) return t("server.security.summary.ssh_key_subtitle_not_generated");
    if (pwAuthDisabled) return t("server.security.summary.ssh_key_subtitle_key_only");
    return t("server.security.summary.ssh_key_subtitle_dual");
  }, [sshKeyGenerated, pwAuthDisabled, t]);

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

      {/* Card 3 — SSH-ключ summary (opens SshKeyModal) */}
      <Card data-testid="ssh-key-summary-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <KeyRound
              className="w-5 h-5 shrink-0"
              style={{ color: "var(--color-accent-interactive)" }}
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-subtitle">{t("server.security.summary.ssh_key_card_title")}</h3>
                <StatusIndicator
                  status={sshKeyGenerated ? "success" : "neutral"}
                  size="sm"
                  label={sshKeyStatusText}
                />
              </div>
              <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
                {sshKeySubtitle}
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSshKeyOpen(true)}
            data-testid="ssh-key-configure-button"
          >
            {t("server.security.summary.configure_button")}
          </Button>
        </div>
      </Card>

      {/* Card 4 — TLS Сертификат (CertSection extended in Plan 16-05 Task 2) */}
      <CertSection state={state} security={security} />

      {/* Modals managed at top level (T-03 — isOpen passed as-is, NEVER
          early-return null in parent — Modal primitive owns 200ms exit anim). */}
      <FirewallModal
        isOpen={firewallOpen}
        onClose={() => setFirewallOpen(false)}
        state={security}
      />
      <Fail2banModal
        isOpen={fail2banOpen}
        onClose={() => setFail2banOpen(false)}
        state={security}
        sshParams={state.sshParams}
      />
      <SshKeyModal
        isOpen={sshKeyOpen}
        onClose={() => setSshKeyOpen(false)}
        sshParams={state.sshParams}
      />
    </div>
  );
}
