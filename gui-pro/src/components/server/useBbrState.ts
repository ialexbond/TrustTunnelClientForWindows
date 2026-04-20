import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../../shared/utils/formatError";

interface SshParams {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath?: string;
  [key: string]: unknown;
}

type PushSuccess = (msg: string, type?: "success" | "error") => void;

export function useBbrState(sshParams: SshParams, pushSuccess: PushSuccess) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  const { host, port, user, password, keyPath } = sshParams;

  const detect = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<boolean>("detect_bbr_status", { host, port, user, password, keyPath });
      setEnabled(result);
    } catch {
      setEnabled(false);
    } finally {
      setLoading(false);
    }
  }, [host, port, user, password, keyPath]);

  useEffect(() => { void detect(); }, [detect]);

  const toggle = async () => {
    setToggling(true);
    const wasEnabled = enabled;
    try {
      if (wasEnabled) {
        await invoke<boolean>("disable_bbr", { host, port, user, password, keyPath });
        setEnabled(false);
        pushSuccess(t("server.utilities.bbr.snack.disabled"));
      } else {
        await invoke<boolean>("enable_bbr", { host, port, user, password, keyPath });
        setEnabled(true);
        pushSuccess(t("server.utilities.bbr.snack.enabled"));
      }
    } catch (e) {
      const msg = formatError(e);
      pushSuccess(
        t(wasEnabled ? "server.utilities.bbr.snack.disable_error" : "server.utilities.bbr.snack.enable_error", { error: msg }),
        "error"
      );
      // Re-detect actual server state on error
      void detect();
    } finally {
      setToggling(false);
    }
  };

  return { enabled, loading: loading || toggling, detect, toggle };
}
