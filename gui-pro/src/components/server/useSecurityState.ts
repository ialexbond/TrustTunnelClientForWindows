import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../../shared/utils/formatError";
import { translateSshError } from "../../shared/utils/translateSshError";

// ═══════════════════════════════════════════════════════
// Phase 16 Plan 04 — Fail2Ban presets (D-4.2).
// Three rule-of-thumb configurations + custom slot. Frontend constructs
// the values; backend `security_fail2ban_set_jail` is unchanged.
// ═══════════════════════════════════════════════════════

export const FAIL2BAN_PRESETS = {
  soft:     { maxretry: 10, bantime: "300",  findtime: "600" },
  balanced: { maxretry: 5,  bantime: "600",  findtime: "600" },
  strict:   { maxretry: 3,  bantime: "3600", findtime: "600" },
} as const;
export type Fail2banPresetId = keyof typeof FAIL2BAN_PRESETS | "custom";

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

export interface SshKeyStatus {
  generated: boolean;
  authorized_on_server: boolean;
  pubkey_fingerprint?: string;
  password_auth_disabled: boolean;
}

export interface SecurityStatus {
  fail2ban: Fail2banStatus;
  firewall: FirewallStatus;
  // Phase 16 — additive optional field per R-9 backwards-compat (OverviewSection
  // security summary block consumes existing shape unchanged).
  ssh_key?: SshKeyStatus;
}

// Phase 16 Plan 05 — Certbot timer (auto-renewal) status (D-5.3).
// Returned by `server_get_certbot_timer_status` backend command. Optional —
// invoke-time error (cert path missing / certbot not installed) fallbacks
// to all-false stub locally.
export interface CertbotTimerStatus {
  timer_enabled: boolean;
  timer_active: boolean;
  cron_present: boolean;
  auto_renewal_active: boolean;
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

export function useSecurityState(sshParams: SshParams, pushSuccess: PushSuccess, onPortChanged?: (newPort: number) => void) {
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

  // Phase 16 Plan 05 — Certbot timer (TLS auto-renewal) state.
  const [certbotTimerStatus, setCertbotTimerStatus] = useState<CertbotTimerStatus | null>(null);


  // Depend on primitives, not the sshParams object.
  const { host, port, user, password, keyPath } = sshParams;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await invoke<SecurityStatus>("security_get_status", { host, port, user, password, keyPath });
      setStatus(s);
    } catch (e) {
      // FIX-MM: run raw error through translateSshError first — otherwise
      // codes like SSH_CHANNEL_FAILED leak into the UI as "Операция не
      // выполнена: SSH_CHANNEL_FAILED|Failed to open channel (ConnectFailed)",
      // which is unhelpful. translateSshError maps known codes to i18n; if
      // nothing matches it returns raw — so backend_generic wraps either
      // the localized message or the raw fallback uniformly.
      const raw = formatError(e);
      const translated = translateSshError(raw, t);
      pushSuccess(
        translated !== raw
          ? translated
          : t("server.security.errors.backend_generic", { msg: raw }),
        "error",
      );
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
    if (raw.includes("SSH_PORT_CHANGE_FAILED")) {
      const msg = raw.split("|").slice(1).join("|") || "";
      return t("server.security.errors.port_change_failed", { msg });
    }
    if (raw.includes("SSH_PORT_VALIDATION_FAILED")) {
      const msg = raw.split("|").slice(1).join("|") || "";
      return t("server.security.errors.port_validation_failed", { msg });
    }
    if (raw.includes("SSH_UNSUPPORTED_OS")) {
      return t("server.security.errors.unsupported_os");
    }
    // Phase 16 — SSH key + disable PWAuth + certbot timer error markers.
    if (raw.includes("KEY_GEN_FAILED"))               return t("server.security.errors.key_gen_failed");
    if (raw.includes("KEY_STORE_FAILED"))             return t("server.security.errors.key_store_failed");
    if (raw.includes("KEY_NOT_FOUND"))                return t("server.security.errors.key_not_found");
    if (raw.includes("INVALID_ED25519_PUBKEY") || raw.includes("INVALID_PEM"))
                                                      return t("server.security.errors.pubkey_invalid");
    if (raw.includes("AUTHORIZED_KEYS_WRITE_FAILED")) return t("server.security.errors.authorized_keys_failed");
    if (raw.includes("KEY_BACKUP_WRITE_FAILED")) {
      const detail = raw.split("|").slice(1).join("|");
      return t("server.security.errors.key_backup_write_failed", { detail });
    }
    if (raw.includes("KEY_IMPORT_READ_FAILED")) {
      const detail = raw.split("|").slice(1).join("|");
      return t("server.security.errors.key_import_read_failed", { detail });
    }
    if (raw.includes("PWAUTH_DISABLE_FAILED|sshd_validation")) {
      const detail = raw.split("|").slice(2).join("|");
      return t("server.security.errors.pwauth_sshd_validation_failed", { detail });
    }
    if (raw.includes("PWAUTH_DISABLE_FAILED|restart_failed")) {
      const detail = raw.split("|").slice(2).join("|");
      return t("server.security.errors.pwauth_restart_failed", { detail });
    }
    if (raw.includes("PWAUTH_DISABLE_FAILED|backup_failed")) return t("server.security.errors.pwauth_backup_failed");
    if (raw.includes("CERTBOT_TIMER_ENABLE_FAILED"))         return t("server.security.errors.certbot_timer_failed");
    // FIX-MM: defer to the generic SSH error translator for codes we didn't
    // special-case above (SSH_CHANNEL_FAILED, SSH_CONNECT_FAILED, etc.).
    // That table already covers the common connection-layer failures — no
    // point duplicating it here.
    const translated = translateSshError(raw, t);
    if (translated !== raw) return translated;
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
  // P UAT 2026-05-04: hook-internal confirm() removed (mirror Brandmauer
  // overhaul pattern). UI layer (Fail2banModal) owns all confirm UX.
  const installFail2ban = () =>
    run(
      "install-f2b",
      () => invoke("security_install_fail2ban", sshParams),
      t("server.security.snack.fail2ban_installed"),
    );
  const uninstallFail2ban = () =>
    run(
      "uninstall-f2b",
      () => invoke("security_uninstall_fail2ban", sshParams),
      t("server.security.snack.fail2ban_uninstalled"),
    );
  const stopFail2ban = () =>
    run(
      "stop-f2b",
      () => invoke("security_stop_fail2ban", sshParams),
      t("server.security.snack.fail2ban_stopped"),
    );
  const startFail2ban = () =>
    run(
      "start-f2b",
      () => invoke("security_start_fail2ban", sshParams),
      t("server.security.snack.fail2ban_started"),
    );
  const unbanIp = (jail: string, ip: string) =>
    run(
      `unban-${ip}`,
      () => invoke("security_fail2ban_unban", { ...sshParams, jail, ip }),
      t("server.security.snack.ip_unbanned", { ip }),
    );
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
  // P UAT 2026-05-03 fix: removed hook-internal `confirm()` calls. Каждый
  // Firewall action был оборачивал свой confirm dialog — но UI layer
  // (FirewallModal) тоже добавлял confirm для same actions, в результате
  // получалось 2 stacked dialogs. UI layer теперь — single source of truth
  // для confirm UX. Hook actions = pure invocation + state.load() refresh.
  // Plus the hook-side dialog text was hostile («Не рекомендуется в продакшене»,
  // «Выключить firewall» mixed RU/EN, default «Удалить» button label).
  const installFirewall = () =>
    run(
      "install-fw",
      () => invoke("security_install_firewall", { ...sshParams, keepHttpOpen: false }),
      t("server.security.snack.firewall_enabled"),
    );
  const uninstallFirewall = () =>
    run(
      "uninstall-fw",
      () => invoke("security_uninstall_firewall", sshParams),
      t("server.security.snack.firewall_disabled"),
    );
  const stopFirewall = () =>
    run(
      "stop-fw",
      () => invoke("security_stop_firewall", sshParams),
      t("server.security.snack.firewall_stopped"),
    );
  const startFirewall = () =>
    run(
      "start-fw",
      () => invoke("security_start_firewall", sshParams),
      t("server.security.snack.firewall_started"),
    );
  const deleteRule = (n: number) =>
    run(
      `del-${n}`,
      () => invoke("security_firewall_delete_rule", { ...sshParams, number: n }),
      t("server.security.snack.rule_deleted", { n }),
    );
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

  // ── SSH Port actions ──
  const changeSshPort = async (newPort: number) => {
    setBusySet(prev => { const n = new Set(prev); n.add("change-ssh-port"); return n; });
    try {
      const result = await invoke<{ newPort: number }>("security_change_ssh_port", { ...sshParams, newPort });
      const actualPort = result.newPort;

      // Notify parent to update creds.port (triggers sshParams recalculation)
      onPortChanged?.(actualPort);

      // Optimistically update displayed SSH port so UI reflects change immediately
      // (full reload will happen via useEffect when sshParams.port updates after re-render)
      setStatus(prev => prev ? {
        ...prev,
        firewall: { ...prev.firewall, current_ssh_port: actualPort }
      } : prev);

      // Show success message
      if (actualPort === 22) {
        pushSuccess(t("server.security.snack.port_reset"));
      } else {
        pushSuccess(t("server.security.snack.port_changed", { port: actualPort }));
      }
    } catch (e) {
      showError(formatBackendError(e));
    } finally {
      setBusySet(prev => { const n = new Set(prev); n.delete("change-ssh-port"); return n; });
    }
  };
  const portBusy = isBusy("change-ssh-port");

  // P UAT 2026-05-04 — SSH-key actions УДАЛЕНЫ из hook surface вместе с UI
  // (generateSshKey/exportSshKeyBackup/disablePasswordAuth/enablePasswordAuth/
  // importSshKey/getPubkeyForRecovery). Backend Tauri commands остаются как
  // dead code (могут вернуться после redesign feature). UI-flow убран per
  // user request — фича работала плохо (false-positive uploads, lockout
  // scenarios, contradictory status display).

  // ── Phase 16 Plan 04 — Fail2Ban preset actions (D-4.2) ──
  // Backend command unchanged; frontend just constructs config from PRESETS map.
  // Note: ConfirmDialog NOT here — Fail2banModal owns immediate-apply UX
  // (preset radio click triggers apply; no confirm needed).
  const applyFail2banPreset = async (preset: keyof typeof FAIL2BAN_PRESETS): Promise<void> => {
    const cfg = FAIL2BAN_PRESETS[preset];
    void run(
      `f2b-preset-${preset}`,
      () => invoke("security_fail2ban_set_jail", {
        ...sshParams,
        jail: "sshd",
        config: { enabled: true, ...cfg },
      }),
      t("server.security.fail2ban.snack.preset_applied", {
        preset: t(`server.security.fail2ban.presets.${preset}`),
      }),
    );
  };

  const applyFail2banCustom = async (custom: { maxretry: number; bantime: string; findtime: string }): Promise<void> => {
    void run(
      "f2b-preset-custom",
      () => invoke("security_fail2ban_set_jail", {
        ...sshParams,
        jail: "sshd",
        config: { enabled: true, ...custom },
      }),
      t("server.security.fail2ban.snack.preset_applied_custom"),
    );
  };

  // ── Phase 16 Plan 05 — Certbot timer (TLS auto-renewal) actions (D-5.3) ──
  // Reads systemd timer state via `server_get_certbot_timer_status`. If the
  // backend command rejects (cert path missing / certbot not installed),
  // we fallback to an all-false stub so the UI can render the
  // "Включить автообновление" CTA without throwing.
  const loadCertbotTimerStatus = useCallback(async () => {
    try {
      const result = await invoke<CertbotTimerStatus>("server_get_certbot_timer_status", sshParams);
      setCertbotTimerStatus(result);
    } catch {
      // Non-fatal — backend rejects when cert/certbot missing. UI shows
      // "auto_renewal_not_setup" + enable CTA, mirroring real-world flow.
      setCertbotTimerStatus({
        timer_enabled: false,
        timer_active: false,
        cron_present: false,
        auto_renewal_active: false,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on primitives just like load()
  }, [host, port, user, password, keyPath]);

  const enableCertbotTimer = async (): Promise<void> => {
    await run(
      "enable-certbot-timer",
      () => invoke("server_enable_certbot_timer", sshParams),
      t("server.cert.snack.auto_renewal_enabled"),
    );
    // Refresh timer status so UI flips to auto_renewal_active=true.
    await loadCertbotTimerStatus();
  };

  // P UAT 2026-05-04 — getPubkeyForRecovery + verifyCertbotRenewal удалены
  // вместе с SSH-key UI и TLS «Проверить» button. Backend commands остаются
  // available в Rust (security_get_pubkey_for_recovery + server_verify_certbot_renewal),
  // но UI-flow убран per user request.

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

    // Actions
    load,
    installFail2ban, uninstallFail2ban, startFail2ban, stopFail2ban,
    banIp, unbanIp, saveJail, loadF2bLog,
    installFirewall, uninstallFirewall, startFirewall, stopFirewall,
    deleteRule, addRule, loadFwLog,
    changeSshPort, portBusy,

    // P UAT 2026-05-04 — SSH key actions removed (feature deleted from UI).

    // Phase 16 Plan 04 — Fail2Ban preset actions
    applyFail2banPreset,
    applyFail2banCustom,

    // Phase 16 Plan 05 — Certbot timer (TLS auto-renewal)
    certbotTimerStatus,
    loadCertbotTimerStatus,
    enableCertbotTimer,

    // For sub-components that need to run arbitrary ops
    run,
    pushSuccess,
    sshParams,
  };
}

export type SecurityState = ReturnType<typeof useSecurityState>;
// Phase 16 — alias for Fail2banModal/FirewallModal consumers per
// PATTERNS.md naming. SecurityState is the canonical name; Use*Return is
// kept for plan compliance + new compound Modals reading hook surface.
export type UseSecurityStateReturn = SecurityState;
