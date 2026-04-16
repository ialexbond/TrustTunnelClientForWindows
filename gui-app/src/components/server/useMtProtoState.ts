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
// 5 steps: download, configure, generate_secret, start_service, complete
// ═══════════════════════════════════════════════════════

const INSTALL_STEPS = [
  { key: "download", labelKey: "server.utilities.mtproto.step.download" },
  { key: "configure", labelKey: "server.utilities.mtproto.step.configure" },
  { key: "generate_secret", labelKey: "server.utilities.mtproto.step.secret" },
  { key: "start_service", labelKey: "server.utilities.mtproto.step.service" },
  { key: "complete", labelKey: "server.utilities.mtproto.step.complete" },
];

// Map backend step names to StepProgress indices
const STEP_INDEX: Record<string, number> = {
  download: 0,
  configure: 1,
  generate_secret: 2,
  start_service: 3,
  complete: 4,
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

  const confirm = useConfirm();

  const { host, port, user, password, keyPath } = sshParams;

  // ── Load status from server (per D-08) ──
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await invoke<MtProtoStatus>("mtproto_get_status", { host, port, user, password, keyPath });
      setStatus(s);
      // Persist to localStorage per MTPROTO-06
      saveCache(host, s);
    } catch {
      // Don't set error -- just means mtg not available, show not_installed
      const notInstalled: MtProtoStatus = { installed: false, active: false, port: 0, secret: "", proxy_link: "" };
      setStatus(notInstalled);
      saveCache(host, notInstalled);
    } finally {
      setLoading(false);
    }
  }, [host, port, user, password, keyPath]);

  // Auto-load on sshParams change (per D-08)
  useEffect(() => { void load(); }, [load]);

  // ── Listen for install step events ──
  useEffect(() => {
    if (!installing) return;
    const unlisten = listen<MtProtoInstallStep>("mtproto-install-step", (event) => {
      const { step, status: stepSt } = event.payload;
      const idx = STEP_INDEX[step] ?? 0;
      setCurrentStep(idx);
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
      pushSuccess(t("server.utilities.mtproto.snack.installed"));
    } catch (e) {
      const msg = formatError(e);
      setError(msg);
      setInstalling(false);
      pushSuccess(t("server.utilities.mtproto.snack.install_error", { error: msg }), "error");
    }
  };

  // ── Uninstall (per D-10, D-11, MTPROTO-08) ──
  const requestUninstall = async () => {
    const ok = await confirm({
      title: t("server.utilities.mtproto.confirm_uninstall_title"),
      message: t("server.utilities.mtproto.confirm_uninstall_message"),
      variant: "warning",
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
      pushSuccess(t("server.utilities.mtproto.snack.uninstalled"));
    } catch (e) {
      const msg = formatError(e);
      setError(msg);
      pushSuccess(t("server.utilities.mtproto.snack.uninstall_error", { error: msg }), "error");
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
    currentStep,
    stepStatus,
    steps,
    load,
    install,
    requestUninstall,
    retry,
    sshParams,
  };
}

export type MtProtoState = ReturnType<typeof useMtProtoState>;
