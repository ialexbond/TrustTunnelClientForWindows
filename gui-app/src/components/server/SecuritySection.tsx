import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Shield,
  RefreshCw,
  Trash2,
  Plus,
  Copy,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Info,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Input } from "../../shared/ui/Input";
import { Select } from "../../shared/ui/Select";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { Modal } from "../../shared/ui/Modal";
import { Tooltip } from "../../shared/ui/Tooltip";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";

// ─── Types mirroring Rust structs ────────────────────────────────────
interface JailInfo {
  name: string;
  enabled: boolean;
  currently_failed: number;
  total_failed: number;
  currently_banned: number;
  total_banned: number;
  banned_ips: string[];
  maxretry: number;
  bantime: string;
  findtime: string;
}
interface Fail2banStatus { installed: boolean; active: boolean; jails: JailInfo[]; }
interface FirewallRule {
  number: number; to: string; from: string; action: string; proto: string; comment: string;
}
interface FirewallStatus {
  installed: boolean; active: boolean;
  default_in: string; default_out: string; default_routed: string;
  logging: string;
  rules: FirewallRule[];
  current_ssh_port: number;
  vpn_port: number | null;
}
interface SecurityStatus { fail2ban: Fail2banStatus; firewall: FirewallStatus; }

interface Props { state: ServerState; }

// ─── Client-side validators (mirror the Rust ones in server_security.rs) ──
// Returns an i18n error key on failure, or null if the value is acceptable.
function validatePort(raw: string): string | null {
  const port = raw.trim();
  if (!port) return "server.security.errors.port_empty";
  if (!/^[0-9]+(:[0-9]+)?$/.test(port)) return "server.security.errors.port_invalid";
  if (port.includes(":")) {
    const [a, b] = port.split(":").map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "server.security.errors.port_range_invalid";
    if (a < 1 || b < 1 || a > 65535 || b > 65535) return "server.security.errors.port_out_of_range";
    if (a >= b) return "server.security.errors.port_range_invalid";
  } else {
    const n = Number(port);
    if (!Number.isFinite(n) || n < 1 || n > 65535) return "server.security.errors.port_out_of_range";
  }
  return null;
}

function validateSource(raw: string): string | null {
  const src = raw.trim();
  if (!src || src === "any") return null;
  // Very permissive — mirrors is_safe_source: hex digits, dots, colons, slash.
  // Accepts IPv4, IPv6, CIDR for either.
  if (src.length > 43) return "server.security.errors.source_invalid";
  if (!/^[0-9a-fA-F.:/]+$/.test(src)) return "server.security.errors.source_invalid";
  // Additional sanity: must contain either a dot (IPv4-ish) or a colon (IPv6-ish)
  if (!src.includes(".") && !src.includes(":")) return "server.security.errors.source_invalid";
  return null;
}

function validateComment(raw: string): string | null {
  if ([...raw].length > 80) return "server.security.errors.comment_too_long";
  if (/["`$\\\n\r]/.test(raw)) return "server.security.errors.comment_bad_chars";
  return null;
}

function validateIp(raw: string): string | null {
  const ip = raw.trim();
  if (!ip) return "server.security.errors.ip_invalid";
  if (ip.length > 45) return "server.security.errors.ip_invalid";
  if (!/^[0-9a-fA-F.:]+$/.test(ip)) return "server.security.errors.ip_invalid";
  if (!ip.includes(".") && !ip.includes(":")) return "server.security.errors.ip_invalid";
  return null;
}

export function SecuritySection({ state }: Props) {
  const { t } = useTranslation();
  const { sshParams } = state;
  // Route errors through the snackbar (not the inline actionResult banner — that one
  // isn't even rendered inside this section).
  const showError = useCallback((msg: string) => {
    state.pushSuccess(msg, "error");
  }, [state]);

  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [loading, setLoading] = useState(false);
  // Set of in-flight operation keys. Allows concurrent operations to each show their
  // own loader independently — clicking "Disable firewall" while "Uninstall fail2ban" is
  // still running won't cancel or replace the first loader.
  const [busySet, setBusySet] = useState<Set<string>>(() => new Set());
  const isBusy = useCallback((key: string) => busySet.has(key), [busySet]);

  // Fail2ban UI state
  const [expandedJail, setExpandedJail] = useState<string | null>(null);
  const [jailDraft, setJailDraft] = useState<Record<string, JailInfo>>({});
  const [showF2bLog, setShowF2bLog] = useState(false);
  const [f2bLog, setF2bLog] = useState("");
  const [manualBanIp, setManualBanIp] = useState("");

  // Firewall UI state
  const [showAddRule, setShowAddRule] = useState(false);
  const [showFwLog, setShowFwLog] = useState(false);
  const [fwLog, setFwLog] = useState("");
  const [newRule, setNewRule] = useState({ port: "", proto: "tcp", action: "allow", from: "", comment: "" });

  // Confirms
  const [confirm, setConfirm] = useState<null | {
    title: string; message: string; onConfirm: () => void; variant?: "danger" | "warning";
  }>(null);

  // Depend on primitives, not the sshParams object — it's recreated every render in useServerState.
  const { host, port, user, password, keyPath } = sshParams;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await invoke<SecurityStatus>("security_get_status", { host, port, user, password, keyPath });
      setStatus(s);
    } catch (e) {
      state.pushSuccess(t("server.security.errors.backend_generic", { msg: formatError(e) }), "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, port, user, password, keyPath]);

  useEffect(() => { void load(); }, [load]);

  // Translate well-known backend error codes to user-friendly i18n messages.
  const formatBackendError = useCallback((e: unknown): string => {
    const raw = formatError(e);
    // SECURITY_UFW_INVALID_RULE → shown when Rust validators reject port/proto/source/comment.
    if (raw.includes("SECURITY_UFW_INVALID_RULE")) return t("server.security.errors.generic_rule_rejected");
    if (raw.includes("SECURITY_F2B_INVALID_IP"))   return t("server.security.errors.ip_invalid");
    if (raw.includes("SECURITY_F2B_INVALID_JAIL")) return t("server.security.errors.generic_rule_rejected");
    return t("server.security.errors.backend_generic", { msg: raw });
  }, [t]);

  const run = async (key: string, fn: () => Promise<unknown>, successMsg?: string) => {
    setBusySet(prev => { const n = new Set(prev); n.add(key); return n; });
    let ok = false;
    try {
      await fn();
      await load();
      ok = true;
    } catch (e) {
      showError(formatBackendError(e));
    } finally {
      setBusySet(prev => { const n = new Set(prev); n.delete(key); return n; });
      // Show the success snackbar ONLY after the full flow (server op + status refresh)
      // has completed AND the loader is no longer spinning.
      if (ok && successMsg) state.pushSuccess(successMsg);
    }
  };

  // Section-level busy flags. Cover BOTH directions (install/uninstall) so the loader
  // stays visible on whichever button is currently rendered when `load()` flips the
  // status and the button label changes mid-flow.
  const f2bBusy = isBusy("install-f2b") || isBusy("uninstall-f2b") || isBusy("start-f2b") || isBusy("stop-f2b");
  const fwBusy  = isBusy("install-fw")  || isBusy("uninstall-fw")  || isBusy("start-fw")  || isBusy("stop-fw");
  // Any ufw-writing op in progress — used to disable rule-list delete buttons so users
  // don't click stale rule numbers after another delete has shifted the list.
  const fwWriting = fwBusy
    || Array.from(busySet).some(k => k.startsWith("del-") || k === "add-rule");

  // ── Fail2ban actions ──
  const installFail2ban = () => setConfirm({
    title: t("server.security.confirm.install_fail2ban_title"),
    message: t("server.security.confirm.install_fail2ban_message"),
    variant: "warning",
    onConfirm: () => {
      setConfirm(null);
      void run(
        "install-f2b",
        () => invoke("security_install_fail2ban", sshParams),
        t("server.security.snack.fail2ban_installed"),
      );
    },
  });
  const uninstallFail2ban = () => setConfirm({
    title: t("server.security.confirm.uninstall_fail2ban_title"),
    message: t("server.security.confirm.uninstall_fail2ban_message"),
    onConfirm: () => {
      setConfirm(null);
      void run(
        "uninstall-f2b",
        () => invoke("security_uninstall_fail2ban", sshParams),
        t("server.security.snack.fail2ban_uninstalled"),
      );
    },
  });
  const stopFail2ban = () => setConfirm({
    title: t("server.security.confirm.stop_fail2ban_title"),
    message: t("server.security.confirm.stop_fail2ban_message"),
    variant: "warning",
    onConfirm: () => {
      setConfirm(null);
      void run(
        "stop-f2b",
        () => invoke("security_stop_fail2ban", sshParams),
        t("server.security.snack.fail2ban_stopped"),
      );
    },
  });
  const startFail2ban = () =>
    run(
      "start-f2b",
      () => invoke("security_start_fail2ban", sshParams),
      t("server.security.snack.fail2ban_started"),
    );
  const unbanIp = (jail: string, ip: string) => setConfirm({
    title: t("server.security.confirm.unban_title", { ip }),
    message: t("server.security.confirm.unban_message", { ip, jail }),
    variant: "warning",
    onConfirm: () => {
      setConfirm(null);
      void run(
        `unban-${ip}`,
        () => invoke("security_fail2ban_unban", { ...sshParams, jail, ip }),
        t("server.security.snack.ip_unbanned", { ip }),
      );
    },
  });
  const banIp = (jail: string) => {
    const ip = manualBanIp.trim();
    if (!ip) return;
    const err = validateIp(ip);
    if (err) { showError(t(err)); return; }
    void run(`ban-${ip}`, async () => {
      await invoke("security_fail2ban_ban", { ...sshParams, jail, ip });
      setManualBanIp("");
    }, t("server.security.snack.ip_banned", { ip }));
  };
  const saveJail = (jail: JailInfo) =>
    run(
      `save-${jail.name}`,
      () => invoke("security_fail2ban_set_jail", {
        ...sshParams,
        jail: jail.name,
        config: { enabled: jail.enabled, maxretry: jail.maxretry, bantime: jail.bantime, findtime: jail.findtime },
      }),
      t("server.security.snack.jail_saved", { jail: jail.name }),
    );
  const loadF2bLog = () =>
    run("f2b-log", async () => {
      const log = await invoke<string>("security_fail2ban_tail_log", { ...sshParams, lines: 200 });
      setF2bLog(log);
    });

  // ── Firewall actions ──
  const installFirewall = () => {
    const ssh = status?.firewall.current_ssh_port ?? sshParams.port;
    const vpn = status?.firewall.vpn_port ?? 443;
    setConfirm({
      title: t("server.security.confirm.install_firewall_title"),
      message: t("server.security.confirm.install_firewall_message", {
        ssh, vpn, http: "",
      }),
      variant: "warning",
      onConfirm: () => {
        setConfirm(null);
        // Port 80 is NOT opened during install — it's managed separately via the live
        // toggle once the firewall is active. The "only during renewal" behavior is
        // handled by renew_cert which auto-opens 80 temporarily.
        void run(
          "install-fw",
          () => invoke("security_install_firewall", { ...sshParams, keepHttpOpen: false }),
          t("server.security.snack.firewall_enabled"),
        );
      },
    });
  };
  const uninstallFirewall = () => setConfirm({
    title: t("server.security.confirm.uninstall_firewall_title"),
    message: t("server.security.confirm.uninstall_firewall_message"),
    onConfirm: () => {
      setConfirm(null);
      void run(
        "uninstall-fw",
        () => invoke("security_uninstall_firewall", sshParams),
        t("server.security.snack.firewall_disabled"),
      );
    },
  });
  const stopFirewall = () => setConfirm({
    title: t("server.security.confirm.stop_firewall_title"),
    message: t("server.security.confirm.stop_firewall_message"),
    variant: "warning",
    onConfirm: () => {
      setConfirm(null);
      void run(
        "stop-fw",
        () => invoke("security_stop_firewall", sshParams),
        t("server.security.snack.firewall_stopped"),
      );
    },
  });
  const startFirewall = () =>
    run(
      "start-fw",
      () => invoke("security_start_firewall", sshParams),
      t("server.security.snack.firewall_started"),
    );
  const deleteRule = (n: number) => setConfirm({
    title: t("server.security.confirm.delete_rule_title"),
    message: t("server.security.confirm.delete_rule_message", { n }),
    onConfirm: () => {
      setConfirm(null);
      void run(
        `del-${n}`,
        () => invoke("security_firewall_delete_rule", { ...sshParams, number: n }),
        t("server.security.snack.rule_deleted", { n }),
      );
    },
  });
  const addRule = async () => {
    const portErr    = validatePort(newRule.port);
    if (portErr)    { showError(t(portErr)); return; }
    const sourceErr  = validateSource(newRule.from);
    if (sourceErr)  { showError(t(sourceErr)); return; }
    const commentErr = validateComment(newRule.comment);
    if (commentErr) { showError(t(commentErr)); return; }

    // Keep modal open during the entire flow (invoke + load). It closes only on success.
    await run("add-rule", async () => {
      await invoke("security_firewall_add_rule", { ...sshParams, rule: newRule });
    }, t("server.security.snack.rule_added"));
    // Only close + reset AFTER run() fully completes (server op + status refresh).
    setShowAddRule(false);
    setNewRule({ port: "", proto: "tcp", action: "allow", from: "", comment: "" });
  };
  const loadFwLog = () =>
    run("fw-log", async () => {
      const log = await invoke<string>("security_firewall_tail_log", { ...sshParams, lines: 200 });
      setFwLog(log);
    });

  // ── Render ──
  return (
    <Card>
      <CardHeader
        title={t("server.security.title")}
        icon={<Shield className="w-3.5 h-3.5" />}
        action={
          <div className="flex items-center gap-2">
            <Tooltip text={t("server.security.tooltip")}>
              <Info className="w-3.5 h-3.5 cursor-help" style={{ color: "var(--color-text-muted)" }} />
            </Tooltip>
            <Button variant="ghost" size="sm" icon={<RefreshCw className="w-3 h-3" />} onClick={() => void load()} disabled={loading}>
              {t("server.security.refresh")}
            </Button>
          </div>
        }
      />

      {loading && !status && (
        <div className="flex items-center gap-2 text-xs py-3" style={{ color: "var(--color-text-muted)" }}>
          <Loader2 className="w-3 h-3 animate-spin" /> {t("server.security.loading")}
        </div>
      )}

      {status && (
        <div className="space-y-4">
          {/* ═════════ FAIL2BAN ═════════ */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold" style={{ color: "var(--color-text-primary)" }}>
                  {t("server.security.fail2ban.title")}
                </span>
                <StatusBadge
                  state={
                    !status.fail2ban.installed ? "off" :
                    status.fail2ban.active ? "on" : "warn"
                  }
                  label={
                    !status.fail2ban.installed ? t("server.security.fail2ban.not_installed") :
                    status.fail2ban.active ? t("server.security.fail2ban.active") :
                    t("server.security.fail2ban.installed_inactive")
                  }
                />
              </div>
              {!status.fail2ban.installed ? (
                <Button variant="primary" size="sm" onClick={installFail2ban} loading={isBusy("install-f2b")} disabled={f2bBusy}>
                  {t("server.security.fail2ban.install")}
                </Button>
              ) : (
                <div className="flex gap-1.5">
                  {status.fail2ban.active ? (
                    <Button variant="secondary" size="sm" onClick={stopFail2ban} loading={isBusy("stop-f2b")} disabled={f2bBusy}>
                      {t("server.security.fail2ban.stop")}
                    </Button>
                  ) : (
                    <Button variant="primary" size="sm" onClick={startFail2ban} loading={isBusy("start-f2b")} disabled={f2bBusy}>
                      {t("server.security.fail2ban.start")}
                    </Button>
                  )}
                  <Button variant="danger-outline" size="sm" onClick={uninstallFail2ban} loading={isBusy("uninstall-f2b")} disabled={f2bBusy}>
                    {t("server.security.fail2ban.uninstall")}
                  </Button>
                </div>
              )}
            </div>
            <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
              {t("server.security.fail2ban.desc")}
            </p>

            {status.fail2ban.active && status.fail2ban.jails.length > 0 && (
              <div className="space-y-1.5 mt-2">
                {status.fail2ban.jails.map((jail) => {
                  const draft = jailDraft[jail.name] ?? jail;
                  const isOpen = expandedJail === jail.name;
                  return (
                    <div key={jail.name} className="rounded-[var(--radius-md)] border" style={{ borderColor: "var(--color-border)" }}>
                      <button
                        onClick={() => setExpandedJail(isOpen ? null : jail.name)}
                        className="w-full flex items-center justify-between px-3 py-1.5 text-left"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-mono font-medium" style={{ color: "var(--color-text-primary)" }}>{jail.name}</span>
                          <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
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
                            <div className="text-[10px] font-medium mt-2 mb-1" style={{ color: "var(--color-text-secondary)" }}>
                              {t("server.security.fail2ban.banned_ips")}
                            </div>
                            {jail.banned_ips.length === 0 ? (
                              <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{t("server.security.fail2ban.no_banned")}</div>
                            ) : (
                              <div className="space-y-1">
                                {jail.banned_ips.map(ip => (
                                  <div key={ip} className="flex items-center justify-between text-[11px]">
                                    <code className="font-mono" style={{ color: "var(--color-text-primary)" }}>{ip}</code>
                                    <Button variant="ghost" size="sm" onClick={() => unbanIp(jail.name, ip)} loading={isBusy(`unban-${ip}`)} disabled={isBusy(`unban-${ip}`)}>
                                      {t("server.security.fail2ban.unban")}
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className="flex gap-1.5 mt-2">
                              <Input
                                value={manualBanIp}
                                onChange={(e) => setManualBanIp(e.target.value)}
                                placeholder={t("server.security.fail2ban.ban_ip_placeholder")}
                                className="text-[11px]"
                              />
                              <Button
                                variant="secondary" size="sm"
                                onClick={() => banIp(jail.name)}
                                disabled={!manualBanIp.trim() || isBusy(`ban-${manualBanIp.trim()}`)}
                                loading={isBusy(`ban-${manualBanIp.trim()}`)}
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
                              onChange={(v) => setJailDraft({ ...jailDraft, [jail.name]: { ...draft, maxretry: parseInt(v) || 0 } })}
                            />
                            <LabeledInput
                              label={t("server.security.fail2ban.bantime")}
                              value={draft.bantime}
                              onChange={(v) => setJailDraft({ ...jailDraft, [jail.name]: { ...draft, bantime: v } })}
                            />
                            <LabeledInput
                              label={t("server.security.fail2ban.findtime")}
                              value={draft.findtime}
                              onChange={(v) => setJailDraft({ ...jailDraft, [jail.name]: { ...draft, findtime: v } })}
                            />
                          </div>
                          <div className="flex justify-end">
                            <Button variant="primary" size="sm" onClick={() => saveJail(draft)} loading={isBusy(`save-${jail.name}`)} disabled={isBusy(`save-${jail.name}`)}>
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
            {status.fail2ban.installed && (
              <div>
                <Button
                  variant="ghost" size="sm"
                  icon={showF2bLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  onClick={() => { setShowF2bLog(!showF2bLog); if (!showF2bLog && !f2bLog) loadF2bLog(); }}
                >
                  {showF2bLog ? t("server.security.fail2ban.hide_logs") : t("server.security.fail2ban.show_logs")}
                </Button>
                {showF2bLog && (
                  <LogArea content={f2bLog} loading={isBusy("f2b-log")} pushSuccess={state.pushSuccess} />
                )}
              </div>
            )}
          </div>

          {/* ═════════ FIREWALL ═════════ */}
          <div className="pt-3 border-t space-y-2" style={{ borderColor: "var(--color-border)" }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold" style={{ color: "var(--color-text-primary)" }}>
                  {t("server.security.firewall.title")}
                </span>
                <StatusBadge
                  state={
                    !status.firewall.installed ? "off" :
                    status.firewall.active ? "on" : "warn"
                  }
                  label={
                    !status.firewall.installed ? t("server.security.firewall.not_installed") :
                    status.firewall.active ? t("server.security.firewall.active") :
                    t("server.security.firewall.inactive")
                  }
                />
              </div>
              {!status.firewall.installed ? (
                <Button variant="primary" size="sm" onClick={installFirewall} loading={isBusy("install-fw")} disabled={fwBusy}>
                  {t("server.security.firewall.install")}
                </Button>
              ) : (
                <div className="flex gap-1.5">
                  {status.firewall.active ? (
                    <Button variant="secondary" size="sm" onClick={stopFirewall} loading={isBusy("stop-fw")} disabled={fwBusy}>
                      {t("server.security.firewall.stop")}
                    </Button>
                  ) : (
                    <Button variant="primary" size="sm" onClick={startFirewall} loading={isBusy("start-fw")} disabled={fwBusy}>
                      {t("server.security.firewall.start")}
                    </Button>
                  )}
                  <Button variant="danger-outline" size="sm" onClick={uninstallFirewall} loading={isBusy("uninstall-fw")} disabled={fwBusy}>
                    {t("server.security.firewall.uninstall")}
                  </Button>
                </div>
              )}
            </div>
            <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
              {t("server.security.firewall.desc")}
            </p>

            {!status.firewall.installed && (
              <div className="rounded-[var(--radius-md)] p-2 text-[10px]" style={{ backgroundColor: "var(--color-bg-hover)" }}>
                <div className="flex items-center gap-1.5" style={{ color: "var(--color-warning-500)" }}>
                  <AlertTriangle className="w-3 h-3" />
                  <span>{t("server.security.firewall.warn_lockout", { port: status.firewall.current_ssh_port })}</span>
                </div>
              </div>
            )}

            {status.firewall.active && (() => {
              const port80Open = status.firewall.rules.some(r => r.to === "80/tcp" || r.to === "80");
              return (
              <>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                  <Stat label={t("server.security.firewall.default_in")} value={status.firewall.default_in} />
                  <Stat label={t("server.security.firewall.default_out")} value={status.firewall.default_out} />
                  <Stat label={t("server.security.firewall.current_ssh")} value={String(status.firewall.current_ssh_port)} />
                  <Stat label={t("server.security.firewall.vpn_port")} value={status.firewall.vpn_port?.toString() ?? "—"} />
                </div>

                {/* Port 80 toggle — live, works on active firewall */}
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
                    onClick={() => run(
                      "http-port",
                      () => invoke("security_firewall_set_http_port", { ...sshParams, open: !port80Open }),
                      port80Open
                        ? t("server.security.snack.firewall_stopped")
                        : t("server.security.snack.rule_added"),
                    )}
                    disabled={isBusy("http-port") || fwBusy}
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
                      {isBusy("http-port") && (
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
                      {t("server.security.firewall.rules")} ({status.firewall.rules.length})
                    </span>
                    <Button variant="ghost" size="sm" icon={<Plus className="w-3 h-3" />} onClick={() => setShowAddRule(true)}>
                      {t("server.security.firewall.add_rule")}
                    </Button>
                  </div>
                  {status.firewall.rules.length === 0 ? (
                    <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{t("server.security.firewall.no_rules")}</div>
                  ) : (
                    <div className="space-y-0.5">
                      {status.firewall.rules.map(r => (
                        <div
                          key={r.number}
                          className="grid items-center gap-1.5 px-2 py-1 text-[10px] rounded-[var(--radius-sm)]"
                          style={{
                            backgroundColor: "var(--color-bg-hover)",
                            // №  |  Action badge  |  Port  |  From  |  Comment (fills remaining)  |  🗑
                            gridTemplateColumns: "16px 72px 72px 80px minmax(0,1fr) 20px",
                          }}
                        >
                          <span className="font-mono text-right" style={{ color: "var(--color-text-muted)" }}>{r.number}</span>
                          <span
                            className="font-mono px-1.5 py-0.5 rounded text-center"
                            style={{
                              backgroundColor: r.action.startsWith("ALLOW") ? "rgba(16,185,129,0.15)"
                                : r.action.startsWith("DENY") || r.action.startsWith("REJECT") ? "rgba(239,68,68,0.15)"
                                : "rgba(245,158,11,0.15)",
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
                            onClick={() => deleteRule(r.number)}
                            disabled={loading || fwWriting}
                            className="justify-self-end p-1 rounded hover:bg-[var(--color-bg-secondary)] disabled:opacity-40 disabled:cursor-not-allowed"
                            title={t("server.security.firewall.delete")}
                          >
                            {isBusy(`del-${r.number}`)
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
                    icon={showFwLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    onClick={() => { setShowFwLog(!showFwLog); if (!showFwLog && !fwLog) loadFwLog(); }}
                  >
                    {showFwLog ? t("server.security.firewall.hide_logs") : t("server.security.firewall.show_logs")}
                  </Button>
                  {showFwLog && (
                    <LogArea content={fwLog} loading={isBusy("fw-log")} pushSuccess={state.pushSuccess} />
                  )}
                </div>
              </>);
            })()}
          </div>
        </div>
      )}

      {/* Add rule modal */}
      <Modal open={showAddRule} onClose={() => setShowAddRule(false)}>
        <div className="max-w-sm w-full mx-4 p-5 rounded-2xl space-y-3 shadow-2xl" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
          <h3 className="text-sm font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {t("server.security.firewall.add_rule_title")}
          </h3>
          <div className="space-y-2">
            <LabeledInput
              label={t("server.security.firewall.port_label")}
              value={newRule.port}
              onChange={(v) => setNewRule({ ...newRule, port: v.replace(/[^0-9:]/g, "") })}
              placeholder="443 / 80:90"
              inputMode="numeric"
            />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] mb-0.5" style={{ color: "var(--color-text-muted)" }}>{t("server.security.firewall.proto_label")}</div>
                <Select
                  value={newRule.proto}
                  onChange={(e) => setNewRule({ ...newRule, proto: e.target.value })}
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
                  value={newRule.action}
                  onChange={(e) => setNewRule({ ...newRule, action: e.target.value })}
                  options={[
                    { value: "allow", label: "allow" },
                    { value: "deny", label: "deny" },
                    { value: "limit", label: "limit" },
                    { value: "reject", label: "reject" },
                  ]}
                />
              </div>
            </div>
            <LabeledInput label={t("server.security.firewall.from_label")} value={newRule.from} onChange={(v) => setNewRule({ ...newRule, from: v })} placeholder="any / 1.2.3.4 / 10.0.0.0/24" />
            <LabeledInput
              label={t("server.security.firewall.comment_label")}
              value={newRule.comment}
              onChange={(v) => setNewRule({ ...newRule, comment: v })}
              maxLength={80}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <Button variant="ghost" size="sm" fullWidth onClick={() => setShowAddRule(false)}>{t("buttons.cancel")}</Button>
            <Button variant="primary" size="sm" fullWidth onClick={addRule} loading={isBusy("add-rule")} disabled={!newRule.port || isBusy("add-rule")}>
              {t("server.security.firewall.add_rule")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirm dialog */}
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ""}
        message={confirm?.message ?? ""}
        variant={confirm?.variant ?? "danger"}
        confirmLabel={t("buttons.confirm")}
        cancelLabel={t("buttons.cancel")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm?.onConfirm()}
      />
    </Card>
  );
}

// ─── Small helpers ────────────────────────────────────────────────
function StatusBadge({ state, label }: { state: "on" | "off" | "warn"; label: string }) {
  const map = {
    on: { color: "var(--color-success-500)", bg: "rgba(16,185,129,0.12)", icon: <CheckCircle2 className="w-3 h-3" /> },
    warn: { color: "var(--color-warning-500)", bg: "rgba(245,158,11,0.12)", icon: <AlertTriangle className="w-3 h-3" /> },
    off: { color: "var(--color-text-muted)", bg: "var(--color-bg-hover)", icon: <XCircle className="w-3 h-3" /> },
  }[state];
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[10px] font-medium" style={{ color: map.color, backgroundColor: map.bg }}>
      {map.icon}{label}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: "var(--color-text-muted)" }}>{label}</span>
      <span className="font-mono" style={{ color: "var(--color-text-primary)" }}>{value}</span>
    </div>
  );
}

function LogArea({ content, loading: isLoading, pushSuccess }: {
  content: string;
  loading: boolean;
  pushSuccess: (msg: string, type?: "success" | "error") => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content);
    pushSuccess(t("server.logs.copied"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="mt-1 rounded-[var(--radius-md)] overflow-hidden relative"
      style={{ border: "1px solid var(--color-border)", backgroundColor: "var(--color-bg-primary)" }}
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--color-text-muted)" }} />
        </div>
      ) : (
        <>
          {content && (
            <button
              onClick={handleCopy}
              className="absolute top-1.5 right-1.5 p-1 rounded-[var(--radius-sm)] transition-colors z-10"
              style={{ backgroundColor: "var(--color-bg-hover)" }}
              title={t("server.logs.copy")}
            >
              {copied
                ? <CheckCircle2 className="w-3 h-3" style={{ color: "var(--color-success-500)" }} />
                : <Copy className="w-3 h-3" style={{ color: "var(--color-text-muted)" }} />}
            </button>
          )}
          <pre
            className="p-2 pr-7 text-[10px] font-mono max-h-48 whitespace-pre-wrap scroll-overlay"
            style={{ color: "var(--color-text-muted)", overflowY: "auto" }}
          >
            {content || "—"}
          </pre>
        </>
      )}
    </div>
  );
}

function LabeledInput({ label, value, onChange, placeholder, inputMode, maxLength }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "decimal" | "tel" | "search" | "email" | "url" | "none";
  maxLength?: number;
}) {
  const charCount = maxLength ? [...value].length : undefined;
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{label}</span>
        {maxLength != null && (
          <span
            className="text-[9px] tabular-nums"
            style={{ color: charCount! > maxLength ? "var(--color-danger-500)" : "var(--color-text-muted)" }}
          >
            {charCount}/{maxLength}
          </span>
        )}
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        className="text-[11px]"
      />
    </div>
  );
}
