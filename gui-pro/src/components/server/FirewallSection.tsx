import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Trash2,
  Plus,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { Select } from "../../shared/ui/Select";
import { Modal } from "../../shared/ui/Modal";
import type { FirewallStatus, SecurityState } from "./useSecurityState";
import { StatusBadge, Stat, LabeledInput, LogArea } from "./_securityHelpers";

interface FirewallSectionProps {
  status: FirewallStatus;
  state: SecurityState;
}

export function FirewallSection({ status, state }: FirewallSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="pt-3 border-t space-y-2" style={{ borderColor: "var(--color-border)" }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {t("server.security.firewall.title")}
          </span>
          <StatusBadge
            state={
              !status.installed ? "off" :
              status.active ? "on" : "warn"
            }
            label={
              !status.installed ? t("server.security.firewall.not_installed") :
              status.active ? t("server.security.firewall.active") :
              t("server.security.firewall.inactive")
            }
          />
        </div>
        {!status.installed ? (
          <Button variant="primary" size="sm" onClick={state.installFirewall} loading={state.isBusy("install-fw")} disabled={state.fwBusy}>
            {t("server.security.firewall.install")}
          </Button>
        ) : (
          <div className="flex gap-1.5">
            {status.active ? (
              <Button variant="ghost" size="sm" onClick={state.stopFirewall} loading={state.isBusy("stop-fw")} disabled={state.fwBusy}>
                {t("server.security.firewall.stop")}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={state.startFirewall} loading={state.isBusy("start-fw")} disabled={state.fwBusy}>
                {t("server.security.firewall.start")}
              </Button>
            )}
            <Button variant="danger" size="sm" onClick={state.uninstallFirewall} loading={state.isBusy("uninstall-fw")} disabled={state.fwBusy}>
              {t("server.security.firewall.uninstall")}
            </Button>
          </div>
        )}
      </div>
      <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
        {t("server.security.firewall.desc")}
      </p>

      {!status.installed && (
        <div className="rounded-[var(--radius-md)] p-2 text-[10px]" style={{ backgroundColor: "var(--color-bg-hover)" }}>
          <div className="flex items-center gap-1.5" style={{ color: "var(--color-warning-500)" }}>
            <AlertTriangle className="w-3 h-3" />
            <span>{t("server.security.firewall.warn_lockout", { port: status.current_ssh_port })}</span>
          </div>
        </div>
      )}

      {status.active && (() => {
        const port80Open = status.rules.some(r => r.to === "80/tcp" || r.to === "80");
        return (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
            <Stat label={t("server.security.firewall.default_in")} value={status.default_in} />
            <Stat label={t("server.security.firewall.default_out")} value={status.default_out} />
            <Stat label={t("server.security.firewall.current_ssh")} value={String(status.current_ssh_port)} />
            <Stat label={t("server.security.firewall.vpn_port")} value={status.vpn_port?.toString() ?? "\u2014"} />
          </div>

          {/* Port 80 toggle */}
          <div className="flex items-center justify-between px-3 py-1.5 rounded-[var(--radius-md)]" style={{ borderBottom: "1px solid var(--color-border)" }}>
            <div className="leading-tight">
              <span className="text-xs font-medium" style={{ color: "var(--color-text-primary)" }}>
                {t("server.security.firewall.http_mode_title")}
              </span>
              <span className="text-[10px] block" style={{ color: "var(--color-text-muted)", marginTop: "1px" }}>
                {port80Open ? t("server.security.firewall.http_mode_always") : t("server.security.firewall.http_mode_renewal")}
              </span>
            </div>
            <button
              onClick={() => state.run(
                "http-port",
                () => invoke("security_firewall_set_http_port", { ...state.sshParams, open: !port80Open }),
                port80Open
                  ? t("server.security.snack.firewall_stopped")
                  : t("server.security.snack.rule_added"),
              )}
              disabled={state.isBusy("http-port") || state.fwBusy}
              className="shrink-0 rounded-full focus:outline-none relative overflow-hidden"
              style={{
                width: "40px",
                height: "22px",
                backgroundColor: port80Open ? "var(--color-accent-500)" : "var(--color-border)",
                transition: "background-color 0.3s ease",
              }}
            >
              <span
                className="absolute flex items-center justify-center rounded-full"
                style={{
                  width: "18px",
                  height: "18px",
                  top: "2px",
                  left: port80Open ? "20px" : "2px",
                  backgroundColor: "white",
                  transition: "left 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                }}
              >
                {state.isBusy("http-port") && (
                  <svg className="animate-spin" width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <circle cx="5" cy="5" r="4" stroke="var(--color-accent-500)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="12 8" />
                  </svg>
                )}
              </span>
            </button>
          </div>

          {/* Rules table */}
          <div className="mt-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-medium" style={{ color: "var(--color-text-secondary)" }}>
                {t("server.security.firewall.rules")} ({status.rules.length})
              </span>
              <Button variant="ghost" size="sm" icon={<Plus className="w-3 h-3" />} onClick={() => state.setShowAddRule(true)}>
                {t("server.security.firewall.add_rule")}
              </Button>
            </div>
            {status.rules.length === 0 ? (
              <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{t("server.security.firewall.no_rules")}</div>
            ) : (
              <div className="space-y-0.5">
                {status.rules.map(r => (
                  <div
                    key={r.number}
                    className="grid items-center gap-1.5 px-2 py-1 text-[10px] rounded-[var(--radius-sm)]"
                    style={{
                      backgroundColor: "var(--color-bg-hover)",
                      gridTemplateColumns: "16px 72px 72px 80px minmax(0,1fr) 20px",
                    }}
                  >
                    <span className="font-mono text-right" style={{ color: "var(--color-text-muted)" }}>{r.number}</span>
                    <span
                      className="font-mono px-1.5 py-0.5 rounded text-center"
                      style={{
                        backgroundColor: r.action.startsWith("ALLOW") ? "var(--color-success-tint-15)"
                          : r.action.startsWith("DENY") || r.action.startsWith("REJECT") ? "var(--color-danger-tint-15)"
                          : "var(--color-warning-tint-15)",
                        color: r.action.startsWith("ALLOW") ? "var(--color-success-500)"
                          : r.action.startsWith("DENY") || r.action.startsWith("REJECT") ? "var(--color-danger-500)"
                          : "var(--color-warning-500)",
                      }}
                    >
                      {r.action}
                    </span>
                    <span className="font-mono truncate" style={{ color: "var(--color-text-primary)" }}>{r.to}</span>
                    <span className="font-mono truncate" style={{ color: "var(--color-text-muted)" }}>{r.from}</span>
                    <span
                      className="truncate italic"
                      style={{ color: "var(--color-text-muted)" }}
                      title={r.comment || undefined}
                    >
                      {r.comment ? `# ${r.comment}` : ""}
                    </span>
                    <button
                      onClick={() => state.deleteRule(r.number)}
                      disabled={state.loading || state.fwWriting}
                      className="justify-self-end p-1 rounded hover:bg-[var(--color-bg-secondary)] disabled:opacity-40 disabled:cursor-not-allowed"
                      title={t("server.security.firewall.delete")}
                    >
                      {state.isBusy(`del-${r.number}`)
                        ? <Loader2 className="w-3 h-3 animate-spin" style={{ color: "var(--color-danger-500)" }} />
                        : <Trash2 className="w-3 h-3" style={{ color: "var(--color-danger-500)" }} />}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Logs */}
          <div>
            <Button
              variant="ghost" size="sm"
              icon={state.showFwLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              onClick={() => { state.setShowFwLog(!state.showFwLog); if (!state.showFwLog && !state.fwLog) state.loadFwLog(); }}
            >
              {state.showFwLog ? t("server.security.firewall.hide_logs") : t("server.security.firewall.show_logs")}
            </Button>
            {state.showFwLog && (
              <LogArea content={state.fwLog} loading={state.isBusy("fw-log")} pushSuccess={state.pushSuccess} />
            )}
          </div>
        </>);
      })()}

      {/* Add rule modal */}
      <Modal isOpen={state.showAddRule} onClose={() => state.setShowAddRule(false)}>
        <div className="max-w-sm w-full mx-4 p-5 rounded-2xl space-y-3 shadow-2xl" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
          <h3 className="text-sm font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {t("server.security.firewall.add_rule_title")}
          </h3>
          <div className="space-y-2">
            <LabeledInput
              label={t("server.security.firewall.port_label")}
              value={state.newRule.port}
              onChange={(v) => state.setNewRule({ ...state.newRule, port: v.replace(/[^0-9:]/g, "") })}
              placeholder="443 / 80:90"
              inputMode="numeric"
            />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] mb-0.5" style={{ color: "var(--color-text-muted)" }}>{t("server.security.firewall.proto_label")}</div>
                <Select
                  value={state.newRule.proto}
                  onChange={(e) => state.setNewRule({ ...state.newRule, proto: e.target.value })}
                  options={[
                    { value: "tcp", label: "tcp" },
                    { value: "udp", label: "udp" },
                    { value: "any", label: t("server.security.firewall.any") },
                  ]}
                />
              </div>
              <div>
                <div className="text-[10px] mb-0.5" style={{ color: "var(--color-text-muted)" }}>{t("server.security.firewall.action_label")}</div>
                <Select
                  value={state.newRule.action}
                  onChange={(e) => state.setNewRule({ ...state.newRule, action: e.target.value })}
                  options={[
                    { value: "allow", label: "allow" },
                    { value: "deny", label: "deny" },
                    { value: "limit", label: "limit" },
                    { value: "reject", label: "reject" },
                  ]}
                />
              </div>
            </div>
            <LabeledInput label={t("server.security.firewall.from_label")} value={state.newRule.from} onChange={(v) => state.setNewRule({ ...state.newRule, from: v })} placeholder="any / 1.2.3.4 / 10.0.0.0/24" />
            <LabeledInput
              label={t("server.security.firewall.comment_label")}
              value={state.newRule.comment}
              onChange={(v) => state.setNewRule({ ...state.newRule, comment: v })}
              maxLength={80}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <Button variant="ghost" size="sm" fullWidth onClick={() => state.setShowAddRule(false)}>{t("buttons.cancel")}</Button>
            <Button variant="primary" size="sm" fullWidth onClick={state.addRule} loading={state.isBusy("add-rule")} disabled={!state.newRule.port || state.isBusy("add-rule")}>
              {t("server.security.firewall.add_rule")}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
