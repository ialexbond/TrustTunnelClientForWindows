import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Send, Copy, Check, Trash2 } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { NumberInput } from "../../shared/ui";
import { StepProgress } from "./StepProgress";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import type { MtProtoState } from "./useMtProtoState";

/**
 * MtProtoModal — Phase 17 Plan 04 (D-4.1).
 *
 * Modal compound для MTProto Proxy (аналог FirewallModal из Phase 16).
 * Принимает `state: MtProtoState` (hook instance с install/uninstall/retry/steps).
 *
 * Two visual states:
 *   — Install flow (`!installed`): port input (NumberInput) + Install button +
 *     StepProgress когда installing.
 *   — Configured view (`installed`): port + proxy_link (mono) + Copy + Uninstall.
 *
 * T-03 invariants (Modal lifecycle):
 *   — НИКОГДА не делать `if (!isOpen) return null` перед <Modal> — Modal
 *     primitive управляет 200ms exit animation сам.
 *   — Cleanup локального state через setTimeout(200) — после exit animation.
 *
 * D-29 invariant (security):
 *   — sshParams.password НИКОГДА не попадает в activityLog.
 *   — proxy_link (содержит MTProto secret) НИКОГДА не попадает в activityLog.
 *   — Логируем только metadata: host, port number (not secret).
 */

export interface MtProtoModalProps {
  isOpen: boolean;
  onClose: () => void;
  state: MtProtoState;
  sshParams: {
    host: string;
    port: number;
    user: string;
    password: string;
    keyPath?: string;
    keyData?: string;
  };
}

export function MtProtoModal({ isOpen, onClose, state, sshParams }: MtProtoModalProps) {
  const { t } = useTranslation();
  const { log } = useActivityLog();

  // ── Local form state ──
  const [portInput, setPortInput] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);

  // ── T-03: cleanup delayed by 200ms after close (matches Modal exit animation) ──
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      setPortInput("");
      setCopied(false);
      setPortError(null);
    }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on close edge only
  }, [isOpen]);

  // ── Default port generation on first open when not installed ──
  useEffect(() => {
    if (isOpen && !state.status?.installed && portInput === "") {
      const randomPort = 1024 + Math.floor(Math.random() * (65535 - 1024));
      setPortInput(String(randomPort));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes portInput
  }, [isOpen, state.status?.installed]);

  // ── Handlers ──

  const handleInstall = useCallback(async () => {
    const parsed = parseInt(portInput, 10);
    if (isNaN(parsed) || parsed < 1024 || parsed > 65535) {
      setPortError(t("server.utilities.mtproto.port_validation_error"));
      return;
    }
    setPortError(null);
    // D-29: log only metadata (host + port number) — NEVER password or secret
    log("STATE", `mtproto.install.start host=${sshParams.host} port=${parsed}`);
    await state.install(parsed);
  }, [portInput, sshParams.host, state, log, t]);

  const handleUninstall = useCallback(async () => {
    // D-29: log only metadata — NEVER password
    log("STATE", `mtproto.uninstall.start host=${sshParams.host}`);
    await state.requestUninstall();
  }, [sshParams.host, state, log]);

  const handleCopy = useCallback(async () => {
    const link = state.status?.proxy_link;
    if (!link) return;
    await navigator.clipboard.writeText(link);
    // D-29: log only event metadata — NEVER log proxy_link (contains MTProto secret)
    log("USER", `mtproto.link.copied host=${sshParams.host}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [state.status?.proxy_link, sshParams.host, log]);

  const installed = state.status?.installed ?? false;

  // T-03: NEVER `if (!isOpen) return null` — Modal primitive owns 200ms exit animation
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Send
          className="w-5 h-5 shrink-0"
          style={{ color: "var(--color-accent-interactive)" }}
          aria-hidden="true"
        />
        <h2 className="text-title">
          {installed
            ? t("server.utilities.mtproto.modal_title_configure")
            : t("server.utilities.mtproto.modal_title_install")}
        </h2>
      </div>

      {/* Install flow — shown when !installed */}
      {!installed && (
        <div className="space-y-3">
          <p className="text-body-sm" style={{ color: "var(--color-text-secondary)" }}>
            {t("server.utilities.mtproto.empty_hint")}
          </p>

          <div>
            <label
              className="text-caption block mb-1"
              style={{ color: "var(--color-text-muted)" }}
            >
              {t("server.utilities.mtproto.port_label")}
            </label>
            <NumberInput
              value={portInput}
              onChange={setPortInput}
              min={1024}
              max={65535}
              placeholder={t("server.utilities.mtproto.port_placeholder")}
              disabled={state.installing}
              aria-label={t("server.utilities.mtproto.port_label")}
            />
            {portError && (
              <p
                className="text-caption mt-1"
                style={{ color: "var(--color-status-error)" }}
                role="alert"
              >
                {portError}
              </p>
            )}
          </div>

          {/* StepProgress shown during installation */}
          {state.installing && (
            <StepProgress
              steps={state.steps}
              currentStep={state.currentStep}
              status={state.stepStatus}
            />
          )}

          {/* Error state — show retry option */}
          {!state.installing && state.error && (
            <div className="flex items-center gap-2">
              <p
                className="text-body-sm flex-1 truncate"
                style={{ color: "var(--color-status-error)" }}
              >
                {state.error}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => state.retry(parseInt(portInput, 10) || 0)}
              >
                {t("server.utilities.mtproto.retry")}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Configured view — shown when installed */}
      {installed && (
        <div className="space-y-3">
          {/* Port display row */}
          <div
            className="flex items-center justify-between gap-3 py-2 border-b"
            style={{ borderColor: "var(--color-border)" }}
          >
            <span className="text-body-sm" style={{ color: "var(--color-text-secondary)" }}>
              {t("server.utilities.mtproto.port_label")}
            </span>
            <span className="text-mono-sm" style={{ color: "var(--color-text-primary)" }}>
              {state.status?.port}
            </span>
          </div>

          {/* Proxy link display */}
          {state.status?.proxy_link && (
            <div>
              <p
                className="text-caption mb-1"
                style={{ color: "var(--color-text-muted)" }}
              >
                {t("server.utilities.mtproto.proxy_link_label")}
              </p>
              <code
                className="text-mono-sm break-all block py-2 px-3 rounded-[var(--radius-md)]"
                style={{
                  color: "var(--color-accent-interactive)",
                  backgroundColor: "var(--color-bg-secondary)",
                }}
              >
                {state.status.proxy_link}
              </code>
            </div>
          )}

          {/* Actions row */}
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              onClick={() => void handleCopy()}
              disabled={!state.status?.proxy_link}
            >
              {copied ? t("server.utilities.mtproto.copied") : t("server.utilities.mtproto.copy")}
            </Button>
            <Button
              variant="danger-outline"
              size="sm"
              icon={<Trash2 className="w-3.5 h-3.5" />}
              loading={state.uninstalling}
              disabled={state.uninstalling}
              onClick={() => void handleUninstall()}
            >
              {t("server.utilities.mtproto.uninstall")}
            </Button>
          </div>
        </div>
      )}

      {/* Footer — Install button (when !installed) or Close button */}
      <div className="flex justify-end gap-2 mt-4">
        {!installed && (
          <Button
            variant="primary"
            size="sm"
            loading={state.installing}
            disabled={state.installing}
            onClick={() => void handleInstall()}
            data-testid="mtproto-install-button"
          >
            {t("server.utilities.mtproto.install")}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("buttons.close")}
        </Button>
      </div>
    </Modal>
  );
}
