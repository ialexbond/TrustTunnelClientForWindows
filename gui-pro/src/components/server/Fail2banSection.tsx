import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { Input } from "../../shared/ui/Input";
import type { Fail2banStatus, SecurityState } from "./useSecurityState";
import { StatusBadge, LabeledInput, LogArea } from "./_securityHelpers";

interface Fail2banSectionProps {
  status: Fail2banStatus;
  state: SecurityState;
}

export function Fail2banSection({ status, state }: Fail2banSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {t("server.security.fail2ban.title")}
          </span>
          <StatusBadge
            state={
              !status.installed ? "off" :
              status.active ? "on" : "warn"
            }
            label={
              !status.installed ? t("server.security.fail2ban.not_installed") :
              status.active ? t("server.security.fail2ban.active") :
              t("server.security.fail2ban.installed_inactive")
            }
          />
        </div>
        {!status.installed ? (
          <Button variant="primary" size="sm" onClick={state.installFail2ban} loading={state.isBusy("install-f2b")} disabled={state.f2bBusy}>
            {t("server.security.fail2ban.install")}
          </Button>
        ) : (
          <div className="flex gap-1.5">
            {status.active ? (
              <Button variant="ghost" size="sm" onClick={state.stopFail2ban} loading={state.isBusy("stop-f2b")} disabled={state.f2bBusy}>
                {t("server.security.fail2ban.stop")}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={state.startFail2ban} loading={state.isBusy("start-f2b")} disabled={state.f2bBusy}>
                {t("server.security.fail2ban.start")}
              </Button>
            )}
            <Button variant="danger" size="sm" onClick={state.uninstallFail2ban} loading={state.isBusy("uninstall-f2b")} disabled={state.f2bBusy}>
              {t("server.security.fail2ban.uninstall")}
            </Button>
          </div>
        )}
      </div>
      <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
        {t("server.security.fail2ban.desc")}
      </p>

      {status.active && status.jails.length > 0 && (
        <div className="space-y-1.5 mt-2">
          {status.jails.map((jail) => {
            const draft = state.jailDraft[jail.name] ?? jail;
            const isOpen = state.expandedJail === jail.name;
            return (
              <div key={jail.name} className="rounded-[var(--radius-md)] border" style={{ borderColor: "var(--color-border)" }}>
                <button
                  onClick={() => state.setExpandedJail(isOpen ? null : jail.name)}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-medium" style={{ color: "var(--color-text-primary)" }}>{jail.name}</span>
                    <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                      {t("server.security.fail2ban.currently_banned")}: <b style={{ color: jail.currently_banned > 0 ? "var(--color-warning-500)" : "var(--color-text-primary)" }}>{jail.currently_banned}</b>
                      {" · "}
                      {t("server.security.fail2ban.total_banned")}: {jail.total_banned}
                    </span>
                  </div>
                  {isOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 space-y-2 border-t" style={{ borderColor: "var(--color-border)" }}>
                    {/* Banned IPs */}
                    <div>
                      <div className="text-xs font-medium mt-2 mb-1" style={{ color: "var(--color-text-secondary)" }}>
                        {t("server.security.fail2ban.banned_ips")}
                      </div>
                      {jail.banned_ips.length === 0 ? (
                        <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>{t("server.security.fail2ban.no_banned")}</div>
                      ) : (
                        <div className="space-y-1">
                          {jail.banned_ips.map(ip => (
                            <div key={ip} className="flex items-center justify-between text-xs">
                              <code className="font-mono" style={{ color: "var(--color-text-primary)" }}>{ip}</code>
                              <Button variant="ghost" size="sm" onClick={() => state.unbanIp(jail.name, ip)} loading={state.isBusy(`unban-${ip}`)} disabled={state.isBusy(`unban-${ip}`)}>
                                {t("server.security.fail2ban.unban")}
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-1.5 mt-2">
                        <Input
                          value={state.manualBanIp}
                          onChange={(e) => state.setManualBanIp(e.target.value)}
                          placeholder={t("server.security.fail2ban.ban_ip_placeholder")}
                          className="text-xs"
                        />
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => state.banIp(jail.name)}
                          disabled={!state.manualBanIp.trim() || state.isBusy(`ban-${state.manualBanIp.trim()}`)}
                          loading={state.isBusy(`ban-${state.manualBanIp.trim()}`)}
                        >
                          {t("server.security.fail2ban.ban")}
                        </Button>
                      </div>
                    </div>
                    {/* Config */}
                    <div className="grid grid-cols-3 gap-2">
                      <LabeledInput
                        label={t("server.security.fail2ban.maxretry")}
                        value={String(draft.maxretry)}
                        onChange={(v) => state.setJailDraft({ ...state.jailDraft, [jail.name]: { ...draft, maxretry: parseInt(v) || 0 } })}
                      />
                      <LabeledInput
                        label={t("server.security.fail2ban.bantime")}
                        value={draft.bantime}
                        onChange={(v) => state.setJailDraft({ ...state.jailDraft, [jail.name]: { ...draft, bantime: v } })}
                      />
                      <LabeledInput
                        label={t("server.security.fail2ban.findtime")}
                        value={draft.findtime}
                        onChange={(v) => state.setJailDraft({ ...state.jailDraft, [jail.name]: { ...draft, findtime: v } })}
                      />
                    </div>
                    <div className="flex justify-end">
                      <Button variant="primary" size="sm" onClick={() => state.saveJail(draft)} loading={state.isBusy(`save-${jail.name}`)} disabled={state.isBusy(`save-${jail.name}`)}>
                        {t("server.security.fail2ban.save")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Logs */}
      {status.installed && (
        <div>
          <Button
            variant="ghost" size="sm"
            icon={state.showF2bLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            onClick={() => { state.setShowF2bLog(!state.showF2bLog); if (!state.showF2bLog && !state.f2bLog) state.loadF2bLog(); }}
          >
            {state.showF2bLog ? t("server.security.fail2ban.hide_logs") : t("server.security.fail2ban.show_logs")}
          </Button>
          {state.showF2bLog && (
            <LogArea content={state.f2bLog} loading={state.isBusy("f2b-log")} pushSuccess={state.pushSuccess} />
          )}
        </div>
      )}
    </div>
  );
}
