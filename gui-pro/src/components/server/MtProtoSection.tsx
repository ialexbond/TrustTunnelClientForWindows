import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Copy, Check, Trash2, Send } from "lucide-react";
import { NumberInput } from "../../shared/ui";
import { Button } from "../../shared/ui/Button";
import { StepProgress } from "./StepProgress";
import type { MtProtoState } from "./useMtProtoState";

interface MtProtoSectionProps {
  state: MtProtoState;
}

export function MtProtoSection({ state }: MtProtoSectionProps) {
  const { t } = useTranslation();
  const [portInput, setPortInput] = useState("");
  const [copied, setCopied] = useState(false);

  const parsedPort = portInput ? parseInt(portInput, 10) : 0;

  const handleInstall = () => {
    state.install(parsedPort);
  };

  const proxyLink = state.status?.proxy_link;
  const handleCopy = useCallback(async () => {
    if (!proxyLink) return;
    await navigator.clipboard.writeText(proxyLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [proxyLink]);

  const handleRetry = () => {
    state.retry(parsedPort);
  };

  // Determine display state
  const isInstalled = state.status?.installed ?? false;
  const isActive = state.status?.active ?? false;

  return (
    <div className="pt-3 border-t space-y-2" style={{ borderColor: "var(--color-border)" }}>
      {/* Title row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Send className="w-3 h-3" style={{ color: "var(--color-accent-400)" }} />
          <span className="text-xs font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {t("server.utilities.mtproto.title")}
          </span>
        </div>
        <span className="text-[10px] font-mono" style={{
          color: state.installing
            ? "var(--color-text-muted)"
            : state.error
              ? "var(--color-danger-500)"
              : isInstalled
                ? isActive ? "var(--color-success-500)" : "var(--color-warning-500)"
                : "var(--color-text-muted)"
        }}>
          {state.installing
            ? t("server.utilities.mtproto.status.installing")
            : state.error
              ? t("server.utilities.mtproto.status.error")
              : isInstalled
                ? isActive ? t("server.utilities.mtproto.status.running") : t("server.utilities.mtproto.status.stopped")
                : t("server.utilities.mtproto.status.not_installed")
          }
        </span>
      </div>

      {/* State: Installing -- show StepProgress */}
      {state.installing && (
        <StepProgress
          steps={state.steps}
          currentStep={state.currentStep}
          status={state.stepStatus}
        />
      )}

      {/* State: Error -- show error message + Retry */}
      {!state.installing && state.error && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs flex-1 truncate" style={{ color: "var(--color-danger-500)" }}>
            {state.error}
          </span>
          <Button variant="primary" size="sm" onClick={handleRetry}>
            {t("server.utilities.mtproto.retry")}
          </Button>
        </div>
      )}

      {/* State: Installed -- show link + Copy + Uninstall */}
      {!state.installing && !state.error && isInstalled && (
        <>
          {state.status?.proxy_link && (
            <div
              className="text-xs font-mono break-all line-clamp-2"
              style={{ color: "var(--color-accent-400)" }}
            >
              {state.status.proxy_link}
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono" style={{ color: "var(--color-text-muted)" }}>
              {t("server.utilities.mtproto.port_display", { port: state.status?.port })}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="primary"
                size="sm"
                icon={copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                onClick={() => void handleCopy()}
                disabled={!state.status?.proxy_link}
              >
                {copied ? t("server.utilities.mtproto.copied") : t("server.utilities.mtproto.copy")}
              </Button>
              <Button
                variant="danger-outline"
                size="sm"
                icon={state.uninstalling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                onClick={state.requestUninstall}
                disabled={state.uninstalling}
              >
                {t("server.utilities.mtproto.uninstall")}
              </Button>
            </div>
          </div>
        </>
      )}

      {/* State: Not Installed -- show port input + Install */}
      {!state.installing && !state.error && !isInstalled && (
        <div className="space-y-2">
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {t("server.utilities.mtproto.empty_hint")}
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <NumberInput
                value={portInput}
                onChange={setPortInput}
                min={1024}
                max={65535}
                placeholder={t("server.utilities.mtproto.port_placeholder")}
              />
            </div>
            <Button variant="primary" size="sm" onClick={handleInstall}>
              {t("server.utilities.mtproto.install")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
