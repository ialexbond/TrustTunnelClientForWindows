import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatError } from "../../shared/utils/formatError";
import { useConfirm } from "../../shared/ui/useConfirm";

// ═══════════════════════════════════════════════════════
// Types mirroring Rust structs
// ═══════════════════════════════════════════════════════

export interface MtProtoStatus {
  installed: boolean;
  active: boolean;
  port: number;
  secret: string;
  proxy_link: string;
}

interface MtProtoInstallStep {
  step: string;
  status: string;
  message: string;
}

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
// localStorage persistence for MTPROTO-06
// ═══════════════════════════════════════════════════════

const STORAGE_KEY_PREFIX = "mtproto_cache_";

function getCacheKey(host: string): string {
  return `${STORAGE_KEY_PREFIX}${host}`;
}

interface MtProtoCache {
  proxy_link: string;
  port: number;
}

function loadCache(host: string): MtProtoCache | null {
  try {
    const raw = localStorage.getItem(getCacheKey(host));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MtProtoCache;
    if (parsed.proxy_link && parsed.port > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

function saveCache(host: string, status: MtProtoStatus): void {
  if (status.installed && status.proxy_link) {
    localStorage.setItem(getCacheKey(host), JSON.stringify({
      proxy_link: status.proxy_link,
      port: status.port,
    }));
  } else {
    localStorage.removeItem(getCacheKey(host));
  }
}

// ═══════════════════════════════════════════════════════
// Step definitions for StepProgress component
// Phase 17.1 (D-5.5): 7 steps under telemt backend rewrite —
//   cleanup_legacy, download_binary, create_user, configure_telemt,
//   start_service, open_firewall, complete
// ═══════════════════════════════════════════════════════

const INSTALL_STEPS = [
  { key: "cleanup_legacy", labelKey: "server.service.mtproto.step.cleanup_legacy" },
  { key: "download_binary", labelKey: "server.service.mtproto.step.download_binary" },
  { key: "create_user", labelKey: "server.service.mtproto.step.create_user" },
  { key: "configure_telemt", labelKey: "server.service.mtproto.step.configure_telemt" },
  { key: "start_service", labelKey: "server.service.mtproto.step.start_service" },
  { key: "open_firewall", labelKey: "server.service.mtproto.step.open_firewall" },
  { key: "complete", labelKey: "server.service.mtproto.step.complete" },
];

// Map backend step names to StepProgress indices
const STEP_INDEX: Record<string, number> = {
  cleanup_legacy: 0,
  download_binary: 1,
  create_user: 2,
  configure_telemt: 3,
  start_service: 4,
  open_firewall: 5,
  complete: 6,
};

// ═══════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════

export function useMtProtoState(sshParams: SshParams, pushSuccess: PushSuccess) {
  const { t } = useTranslation();

  // ── Core state ──
  const [status, setStatus] = useState<MtProtoStatus | null>(() => {
    // Rehydrate from localStorage on mount per MTPROTO-06
    const cached = loadCache(sshParams.host);
    if (cached) {
      return {
        installed: true,
        active: false, // will be updated by server query
        port: cached.port,
        secret: "",
        proxy_link: cached.proxy_link,
      };
    }
    return null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Install progress state ──
  const [installing, setInstalling] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [stepStatus, setStepStatus] = useState<"active" | "error" | "completed">("active");

  // ── Uninstall state ──
  const [uninstalling, setUninstalling] = useState(false);

  // ── Phase 17.1 D-4.3 / Option B (researcher §Migration Plan) ──
  // legacyMigrationNote starts as null. It is set from the event listener when
  // the backend emits step="cleanup_legacy" with a non-empty `message` (the
  // Wave 2 backend renders localized text about a detected legacy MTProxy). We
  // do NOT extend MtProtoStatus — this is event-based, to avoid breaking the
  // frozen API.
  const [legacyMigrationNote, setLegacyMigrationNote] = useState<string | null>(null);

  const confirm = useConfirm();

  const { host, port, user, password, keyPath } = sshParams;

  // ── Load status from server (per D-08) ──
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await invoke<MtProtoStatus>("mtproto_get_status", { host, port, user, password, keyPath });
      setStatus(s);
      // Persist to localStorage per MTPROTO-06. Only a SUCCESSFUL probe is
      // authoritative: if it reports not-installed, saveCache clears the cache.
      saveCache(host, s);
    } catch {
      // E-13 (09-08): a transient SSH hiccup (channel failure, timeout) is
      // indistinguishable from "telemt genuinely not installed". Previously the
      // catch persisted `notInstalled` via saveCache → removeItem, nuking the
      // cached proxy_link and showing «Не установлен» for an installed proxy.
      // Fix: on error, do NOT touch the cache and do NOT overwrite the
      // rehydrated status — keep the last-known cached state. Only the SUCCESS
      // path above is allowed to clear the cache. We swallow the error (no
      // red toast) because the cached link is still the user's best guess.
    } finally {
      setLoading(false);
    }
  }, [host, port, user, password, keyPath]);

  // Auto-load on sshParams change (per D-08)
  useEffect(() => { void load(); }, [load]);

  // ── Phase 17.1 post-UAT (2026-05-21): background polling для proxy_link ──
  //
  // Telemt при первом старте может потратить до 30 сек на определение публичного
  // IP (Telegram backend ping). Backend retry в fetch_proxy_link ловит это за
  // один install-call, но в edge cases (slow DC ping, network hiccup) ссылка
  // приходит ПОСЛЕ возврата install'а. Чтобы UI не показывал пустую ссылку:
  // когда status = installed && active && proxy_link пустой — polling каждые
  // 3 сек до получения непустой ссылки (или max 20 попыток = 60 сек).
  // Останавливается автоматически когда proxy_link становится непустым либо
  // status меняется (uninstall / service stop).
  useEffect(() => {
    if (!status?.installed || !status?.active) return;
    if (status?.proxy_link && status.proxy_link.length > 0) return;
    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      if (cancelled) return;
      attempts += 1;
      if (attempts > 20) return; // 20 × 3s = 60s max polling
      try {
        const s = await invoke<MtProtoStatus>("mtproto_get_status", {
          host, port, user, password, keyPath,
        });
        if (cancelled) return;
        setStatus(s);
        saveCache(host, s);
        if (s.proxy_link && s.proxy_link.length > 0) return; // got link — stop
      } catch {
        // best-effort polling; ignore transient errors
      }
      if (!cancelled) setTimeout(() => void tick(), 3000);
    };
    const initial = setTimeout(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearTimeout(initial);
    };
  }, [status?.installed, status?.active, status?.proxy_link, host, port, user, password, keyPath]);

  // ── Listen for install step events ──
  // Phase 17.1 D-4.3: при step="cleanup_legacy" с непустым message —
  // сохраняем текст в legacyMigrationNote (Option B event mechanism).
  // Backend сам решает emit'ить этот event только если legacy MTProxy найден,
  // поэтому frontend trust'ит наличие message как сигнал «миграция была».
  useEffect(() => {
    if (!installing) return;
    const unlisten = listen<MtProtoInstallStep>("mtproto-install-step", (event) => {
      const { step, status: stepSt, message } = event.payload;
      const idx = STEP_INDEX[step] ?? 0;
      setCurrentStep(idx);
      if (step === "cleanup_legacy" && message && message.trim().length > 0) {
        setLegacyMigrationNote(message);
      }
      if (stepSt === "error") {
        setStepStatus("error");
      } else if (stepSt === "done" && step === "complete") {
        setStepStatus("completed");
      } else {
        setStepStatus("active");
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [installing]);

  // ── Install (per D-01, D-02, MTPROTO-01, MTPROTO-02) ──
  const install = async (mtprotoPort: number) => {
    setInstalling(true);
    setCurrentStep(0);
    setStepStatus("active");
    setLegacyMigrationNote(null); // Phase 17.1 — reset перед свежим install
    setError(null);
    try {
      // NOTE: param name is mtprotoPort (camelCase) which Tauri serde maps to mtproto_port (snake_case) on Rust side
      const result = await invoke<MtProtoStatus>("mtproto_install", {
        host, port, user, password, keyPath,
        mtprotoPort: mtprotoPort,
      });
      setStatus(result);
      setInstalling(false);
      // Persist to localStorage per MTPROTO-06
      saveCache(host, result);
      pushSuccess(t("server.service.mtproto.snack.installed"));
    } catch (e) {
      const msg = formatError(e);
      setInstalling(false);
      // UAT 2026-05-20 — explicit cancel is NOT an error: don't set error state,
      // don't show a red toast. The user knowingly cancelled; we just reset UI.
      if (msg.includes("MTPROTO_INSTALL_CANCELLED")) {
        setError(null);
        pushSuccess(t("server.service.mtproto.snack.cancelled"));
        return;
      }
      setError(msg);
      pushSuccess(t("server.service.mtproto.snack.install_error", { error: msg }), "error");
    }
  };

  // ── Cancel install (UAT 2026-05-20) ──
  // Sets the AppState flag; the next exec_command checkpoint inside
  // server_mtproto.rs returns "MTPROTO_INSTALL_CANCELLED", which the catch
  // above swallows quietly. Safe to call multiple times.
  const cancelInstall = useCallback(async () => {
    try {
      await invoke("mtproto_cancel_install");
    } catch {
      /* noop — best-effort */
    }
  }, []);

  // ── Start / Stop (UAT 2026-05-21) ──
  // Toggle the systemd unit without uninstalling. Both backend verbs
  // re-read full MtProtoStatus before returning, so we can update local
  // state directly without a follow-up load() call.
  const [toggling, setToggling] = useState(false);
  const start = useCallback(async () => {
    setToggling(true);
    setError(null);
    try {
      const s = await invoke<MtProtoStatus>("mtproto_start", {
        host, port, user, password, keyPath,
      });
      setStatus(s);
      saveCache(host, s);
      if (s.active) {
        pushSuccess(t("server.service.mtproto.snack.started"));
      } else {
        // Service didn't reach 'active' after 6 retries — point user at journal.
        pushSuccess(t("server.service.mtproto.snack.start_failed"), "error");
      }
    } catch (e) {
      const msg = formatError(e);
      setError(msg);
      pushSuccess(t("server.service.mtproto.snack.start_error", { error: msg }), "error");
    } finally {
      setToggling(false);
    }
  }, [host, port, user, password, keyPath, pushSuccess, t]);

  const stop = useCallback(async () => {
    setToggling(true);
    setError(null);
    try {
      const s = await invoke<MtProtoStatus>("mtproto_stop", {
        host, port, user, password, keyPath,
      });
      setStatus(s);
      saveCache(host, s);
      pushSuccess(t("server.service.mtproto.snack.stopped"));
    } catch (e) {
      const msg = formatError(e);
      setError(msg);
      pushSuccess(t("server.service.mtproto.snack.stop_error", { error: msg }), "error");
    } finally {
      setToggling(false);
    }
  }, [host, port, user, password, keyPath, pushSuccess, t]);

  // ── Uninstall (per D-10, D-11, MTPROTO-08) ──
  const requestUninstall = async () => {
    const ok = await confirm({
      title: t("server.service.mtproto.confirm_uninstall_title"),
      message: t("server.service.mtproto.confirm_uninstall_message"),
      variant: "warning",
      // §K CONF-04 (09-08): action-verb confirm label so the dialog does not
      // fall back to a generic «Подтвердить» on a destructive action.
      confirmText: t("server.service.mtproto.confirm_uninstall_action"),
    });
    if (!ok) return;
    void doUninstall();
  };

  const doUninstall = async () => {
    setUninstalling(true);
    setError(null);
    try {
      await invoke("mtproto_uninstall", { host, port, user, password, keyPath });
      const notInstalled: MtProtoStatus = { installed: false, active: false, port: 0, secret: "", proxy_link: "" };
      setStatus(notInstalled);
      // Clear localStorage cache per MTPROTO-06
      saveCache(host, notInstalled);
      // Phase 17.1 — после успешного uninstall миграционная заметка теряет
      // смысл (старого MTProxy и так нет, telemt тоже снесён).
      setLegacyMigrationNote(null);
      pushSuccess(t("server.service.mtproto.snack.uninstalled"));
    } catch (e) {
      const msg = formatError(e);
      setError(msg);
      pushSuccess(t("server.service.mtproto.snack.uninstall_error", { error: msg }), "error");
    } finally {
      setUninstalling(false);
    }
  };

  // ── Retry (per D-07 error state) ──
  const retry = (mtprotoPort: number) => {
    setError(null);
    void install(mtprotoPort);
  };

  // ── Translated step labels for StepProgress ──
  const steps = INSTALL_STEPS.map(s => ({ key: s.key, label: t(s.labelKey) }));

  return {
    status,
    loading,
    error,
    installing,
    uninstalling,
    toggling,
    currentStep,
    stepStatus,
    steps,
    load,
    install,
    cancelInstall,
    start,
    stop,
    requestUninstall,
    retry,
    sshParams,
    // Phase 17.1 — additive, не breaking (D-5.1 frozen API + Option B per
    // researcher §Migration Plan: event-based, без contract change на
    // MtProtoStatus). null когда миграция не была обнаружена.
    legacyMigrationNote,
  };
}

export type MtProtoState = ReturnType<typeof useMtProtoState>;
