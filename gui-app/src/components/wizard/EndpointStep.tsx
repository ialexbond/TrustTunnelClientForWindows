import { useTranslation } from "react-i18next";
import {
  Settings, User, Lock, Globe, Mail, Eye, EyeOff, CheckCircle2,
  AlertTriangle, ChevronUp, ChevronDown, Rocket, FileKey, Upload,
  Activity, Gauge, Wifi,
} from "lucide-react";
import { StepBar } from "./StepBar";
import { Toggle } from "../../shared/ui/Toggle";
import { Button } from "../../shared/ui/Button";
import type { WizardState } from "./useWizardState";

export function EndpointStep(w: WizardState) {
  const { t } = useTranslation();

  return (
    <>
      <StepBar step={w.step} isFetchMode={w.isFetchMode} />
      <div className="flex-1 flex items-center justify-center p-4 overflow-y-auto">
        <div className="max-w-sm w-full space-y-3">
          <div className="text-center space-y-1">
            <div className="mx-auto w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: "var(--color-accent-tint-10)" }}>
              <Settings className="w-5 h-5" style={{ color: "var(--color-accent-500)" }} />
            </div>
            <h2 className="text-lg font-bold">{t('wizard.endpoint.title')}</h2>
          </div>

          {/* ── VPN Credentials ── */}
          <div className="glass-card p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-[var(--font-weight-semibold)] uppercase tracking-wider" style={{ color: "var(--color-text-secondary)" }}>
              <User className="w-3 h-3" />
              {t('wizard.endpoint.vpn_credentials')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>{t('wizard.endpoint.login_label')}</label>
                <input
                  type="text"
                  value={w.vpnUsername}
                  onChange={(e) => w.setVpnUsername(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ""))}
                  placeholder="vpnuser"
                  className="wizard-input wizard-input-sm"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>{t('wizard.endpoint.password_label')}</label>
                <div className="relative">
                  <input
                    type={w.showVpnPassword ? "text" : "password"}
                    value={w.vpnPassword}
                    onChange={(e) => w.setVpnPassword(e.target.value.replace(/[^a-zA-Z0-9!@#$%^&*()_+\-=[\]{};':"|,./<>?`~\\]/g, ""))}
                    placeholder="••••••••"
                    className="wizard-input wizard-input-sm pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => w.setShowVpnPassword(!w.showVpnPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 transition-colors" style={{ color: "var(--color-text-muted)" }}
                  >
                    {w.showVpnPassword ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ── TLS Certificate ── */}
          <div className="glass-card p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-[var(--font-weight-semibold)] uppercase tracking-wider" style={{ color: "var(--color-text-secondary)" }}>
              <Lock className="w-3 h-3" />
              {t('wizard.endpoint.tls_certificate')}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {/* Let's Encrypt */}
              <button
                onClick={() => w.setCertType("letsencrypt")}
                className="p-2 rounded-xl text-xs text-left transition-all"
                style={
                  w.certType === "letsencrypt"
                    ? { border: "1px solid var(--color-success-tint-40)", backgroundColor: "var(--color-success-tint-08)", color: "var(--color-text-primary)" }
                    : { border: "1px solid var(--color-border)", backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-secondary)" }
                }
              >
                <div className="font-medium flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" style={{ color: "var(--color-success-500)" }} />
                  Let's Encrypt
                </div>
                <div className="text-[9px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>{t('labels.recommended')}</div>
              </button>

              {/* Self-signed */}
              <button
                onClick={() => w.setCertType("selfsigned")}
                className="p-2 rounded-xl text-xs text-left transition-all"
                style={
                  w.certType === "selfsigned"
                    ? { border: "1px solid var(--color-warning-tint-40)", backgroundColor: "var(--color-warning-tint-08)", color: "var(--color-text-primary)" }
                    : { border: "1px solid var(--color-border)", backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-secondary)" }
                }
              >
                <div className="font-medium">{t('wizard.endpoint.self_signed')}</div>
                <div className="text-[9px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>{t('wizard.endpoint.self_signed_quick')}</div>
              </button>

              {/* Provided / Custom */}
              <button
                onClick={() => w.setCertType("provided")}
                className="p-2 rounded-xl text-xs text-left transition-all"
                style={
                  w.certType === "provided"
                    ? { border: "1px solid var(--color-accent-tint-40)", backgroundColor: "var(--color-accent-tint-08)", color: "var(--color-text-primary)" }
                    : { border: "1px solid var(--color-border)", backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-secondary)" }
                }
              >
                <div className="font-medium flex items-center gap-1">
                  <FileKey className="w-3 h-3" />
                  {t('wizard.endpoint.provided_cert')}
                </div>
                <div className="text-[9px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>{t('wizard.endpoint.provided_cert_hint')}</div>
              </button>
            </div>

            {/* Self-signed warning */}
            {w.certType === "selfsigned" && (
              <div className="flex items-start gap-2 p-2 rounded-lg" style={{ backgroundColor: "var(--color-status-connecting-bg)", border: "1px solid var(--color-status-connecting-border)" }}>
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--color-warning-500)" }} />
                <p className="text-[10px] leading-relaxed" style={{ color: "var(--color-warning-500)" }}>
                  {t('wizard.endpoint.self_signed_warning')}
                </p>
              </div>
            )}

            {/* Let's Encrypt fields */}
            {w.certType === "letsencrypt" && (
              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>{t('labels.domain_name')}</label>
                  <div className="relative">
                    <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
                    <input
                      type="text"
                      value={w.domain}
                      onChange={(e) => w.setDomain(e.target.value)}
                      placeholder="vpn.example.com"
                      className="wizard-input wizard-input-sm pl-9"
                    />
                  </div>
                  <p className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                    {w.host
                      ? t('wizard.endpoint.dns_record_help', { host: w.host })
                      : t('wizard.endpoint.dns_record_help_no_host')}
                  </p>
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>{t('wizard.endpoint.email_label')}</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
                    <input
                      type="email"
                      value={w.email}
                      onChange={(e) => w.setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="wizard-input wizard-input-sm pl-9"
                    />
                  </div>
                  <p className="text-[10px] mt-0.5" style={{ color: w.email.trim() && !w.isValidEmail(w.email) ? "var(--color-danger-500)" : "var(--color-text-muted)" }}>
                    {w.email.trim() && !w.isValidEmail(w.email) ? t('wizard.endpoint.email_invalid') : t('wizard.endpoint.certificate_email_help')}
                  </p>
                </div>
              </div>
            )}

            {/* Provided cert fields */}
            {w.certType === "provided" && (
              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>{t('wizard.endpoint.cert_chain_path')}</label>
                  <div className="relative">
                    <Upload className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
                    <input
                      type="text"
                      value={w.certChainPath}
                      onChange={(e) => w.setCertChainPath(e.target.value)}
                      placeholder="/etc/ssl/certs/cert.pem"
                      className="wizard-input wizard-input-sm pl-9"
                    />
                  </div>
                  <p className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                    {t('wizard.endpoint.cert_chain_path_help')}
                  </p>
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>{t('wizard.endpoint.cert_key_path')}</label>
                  <div className="relative">
                    <FileKey className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
                    <input
                      type="text"
                      value={w.certKeyPath}
                      onChange={(e) => w.setCertKeyPath(e.target.value)}
                      placeholder="/etc/ssl/private/key.pem"
                      className="wizard-input wizard-input-sm pl-9"
                    />
                  </div>
                  <p className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                    {t('wizard.endpoint.cert_key_path_help')}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* ── Server Features ── */}
          <div className="glass-card p-3 space-y-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-[var(--font-weight-semibold)] uppercase tracking-wider" style={{ color: "var(--color-text-secondary)" }}>
              <Activity className="w-3 h-3" />
              {t('wizard.endpoint.server_features')}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
                  <div>
                    <p className="text-xs font-medium" style={{ color: "var(--color-text-primary)" }}>{t('wizard.endpoint.feature_ping')}</p>
                    <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{t('wizard.endpoint.feature_ping_desc')}</p>
                  </div>
                </div>
                <Toggle checked={w.pingEnable} onChange={w.setPingEnable} label="" />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Gauge className="w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
                  <div>
                    <p className="text-xs font-medium" style={{ color: "var(--color-text-primary)" }}>{t('wizard.endpoint.feature_speedtest')}</p>
                    <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{t('wizard.endpoint.feature_speedtest_desc')}</p>
                  </div>
                </div>
                <Toggle checked={w.speedtestEnable} onChange={w.setSpeedtestEnable} label="" />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wifi className="w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
                  <div>
                    <p className="text-xs font-medium" style={{ color: "var(--color-text-primary)" }}>{t('wizard.endpoint.feature_ipv6')}</p>
                    <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{t('wizard.endpoint.feature_ipv6_desc')}</p>
                  </div>
                </div>
                <Toggle checked={w.ipv6Available} onChange={w.setIpv6Available} label="" />
              </div>
            </div>
          </div>

          {/* ── Advanced settings ── */}
          <button
            onClick={() => w.setShowAdvanced(!w.showAdvanced)}
            className="flex items-center gap-1.5 text-[11px] transition-colors" style={{ color: "var(--color-text-muted)" }}
          >
            {w.showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {t('wizard.endpoint.advanced_settings')}
          </button>
          {w.showAdvanced && (
            <div className="glass-card p-3">
              <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>{t('wizard.endpoint.listen_address_label')}</label>
              <input
                type="text"
                value={w.listenAddress}
                onChange={(e) => w.setListenAddress(e.target.value)}
                placeholder="0.0.0.0:443"
                className="wizard-input wizard-input-sm"
              />
              <p className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                {t('wizard.endpoint.listen_address_help')}
              </p>
            </div>
          )}

          {/* DNS warning */}
          {w.certType === "letsencrypt" && w.domain.trim() && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl" style={{ backgroundColor: "var(--color-warning-tint-08)", border: "1px solid var(--color-warning-tint-20)" }}>
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--color-warning-500)" }} />
              <div className="text-[11px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
                <span className="font-[var(--font-weight-semibold)]" style={{ color: "var(--color-warning-500)" }}>{t('wizard.endpoint.dns_warning_important')}</span>{' '}
                {w.host
                  ? t('wizard.endpoint.dns_warning_text', { domain: w.domain, host: w.host })
                  : t('wizard.endpoint.dns_warning_text_no_host', { domain: w.domain })}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => { const goBack = w.cameFromFound || w.serverInfo?.installed ? "found" : "server"; w.setCameFromFound(false); w.setWizardStep(goBack); }}>
              {t('buttons.back')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              icon={<Rocket className="w-4 h-4" />}
              onClick={w.handleDeploy}
              disabled={!w.canDeploy}
            >
              {t('buttons.install')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
