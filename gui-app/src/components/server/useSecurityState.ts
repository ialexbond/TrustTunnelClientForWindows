import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../../shared/utils/formatError";

// ═══════════════════════════════════════════════════════
// Types mirroring Rust structs
// ═══════════════════════════════════════════════════════

export interface JailInfo {
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

export interface Fail2banStatus {
  installed: boolean;
  active: boolean;
  jails: JailInfo[];
}

export interface FirewallRule {
  number: number;
  to: string;
  from: string;
  action: string;
  proto: string;
  comment: string;
}

export interface FirewallStatus {
  installed: boolean;
  active: boolean;
  default_in: string;
  default_out: string;
  default_routed: string;
  logging: string;
  rules: FirewallRule[];
  current_ssh_port: number;
  vpn_port: number | null;
}

export interface SecurityStatus {
  fail2ban: Fail2banStatus;
  firewall: FirewallStatus;
}

// ═══════════════════════════════════════════════════════
// Client-side validators (mirror Rust server_security.rs)
// Returns an i18n error key on failure, or null if OK.
// ═══════════════════════════════════════════════════════

export function validatePort(raw: string): string | null {
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

export function validateSource(raw: string): string | null {
  const src = raw.trim();
  if (!src || src === "any") return null;
  if (src.length > 43) return "server.security.errors.source_invalid";
  if (!/^[0-9a-fA-F.:/]+$/.test(src)) return "server.security.errors.source_invalid";
  if (!src.includes(".") && !src.includes(":")) return "server.security.errors.source_invalid";
  return null;
}

export function validateComment(raw: string): string | null {
  if ([...raw].length > 80) return "server.security.errors.comment_too_long";
  if (/["`$\\\n\r]/.test(raw)) return "server.security.errors.comment_bad_chars";
  return null;
}

export function validateIp(raw: string): string | null {
  const ip = raw.trim();
  if (!ip) return "server.security.errors.ip_invalid";
  if (ip.length > 45) return "server.security.errors.ip_invalid";
  if (!/^[0-9a-fA-F.:]+$/.test(ip)) return "server.security.errors.ip_invalid";
  if (!ip.includes(".") && !ip.includes(":")) return "server.security.errors.ip_invalid";
  return null;
}

// ═══════════════════════════════════════════════════════
// SshParams type (matches useServerState.sshParams shape)
// ═══════════════════════════════════════════════════════

export interface SshParams {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath?: string;
  [key: string]: unknown;
}

type PushSuccess = (msg: string, type?: "success" | "error") => void;

// ═══════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════

export function useSecurityState(sshParams: SshParams, pushSuccess: PushSuccess) {
  const { t } = useTranslation();

  const showError = useCallback((msg: string) => {
    pushSuccess(msg, "error");
  }, [pushSuccess]);

  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [loading, setLoading] = useState(false);
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

  // Depend on primitives, not the sshParams object.
  const { host, port, user, password, keyPath } = sshParams;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await invoke<SecurityStatus>("security_get_status", { host, port, user, password, keyPath });
      setStatus(s);
    } catch (e) {
      pushSuccess(t("server.security.errors.backend_generic", { msg: formatError(e) }), "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, port, user, password, keyPath]);

  useEffect(() => { void load(); }, [load]);

  const formatBackendError = useCallback((e: unknown): string => {
    const raw = formatError(e);
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
      if (ok && successMsg) pushSuccess(successMsg);
    }
  };

  // Section-level busy flags.
  const f2bBusy = isBusy("install-f2b") || isBusy("uninstall-f2b") || isBusy("start-f2b") || isBusy("stop-f2b");
  const fwBusy  = isBusy("install-fw")  || isBusy("uninstall-fw")  || isBusy("start-fw")  || isBusy("stop-fw");
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

    await run("add-rule", async () => {
      await invoke("security_firewall_add_rule", { ...sshParams, rule: newRule });
    }, t("server.security.snack.rule_added"));
    setShowAddRule(false);
    setNewRule({ port: "", proto: "tcp", action: "allow", from: "", comment: "" });
  };
  const loadFwLog = () =>
    run("fw-log", async () => {
      const log = await invoke<string>("security_firewall_tail_log", { ...sshParams, lines: 200 });
      setFwLog(log);
    });

  return {
    // State
    status,
    loading,
    isBusy,
    f2bBusy,
    fwBusy,
    fwWriting,

    // Fail2ban UI state
    expandedJail, setExpandedJail,
    jailDraft, setJailDraft,
    showF2bLog, setShowF2bLog,
    f2bLog,
    manualBanIp, setManualBanIp,

    // Firewall UI state
    showAddRule, setShowAddRule,
    showFwLog, setShowFwLog,
    fwLog,
    newRule, setNewRule,

    // Confirms
    confirm, setConfirm,

    // Actions
    load,
    installFail2ban, uninstallFail2ban, startFail2ban, stopFail2ban,
    banIp, unbanIp, saveJail, loadF2bLog,
    installFirewall, uninstallFirewall, startFirewall, stopFirewall,
    deleteRule, addRule, loadFwLog,

    // For sub-components that need to run arbitrary ops
    run,
    pushSuccess,
    sshParams,
  };
}

export type SecurityState = ReturnType<typeof useSecurityState>;
