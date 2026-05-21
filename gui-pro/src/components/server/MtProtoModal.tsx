import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Send, Copy, Check, Trash2, Loader2, Play, Square } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { NumberInput } from "../../shared/ui";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
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
  // UAT 2026-05-20 — `cancelling` is local UX state that flips to true the
  // moment the user clicks «Отменить», BEFORE waiting for the backend to
  // observe the cancel flag at its next checkpoint. Without this the button
  // looks dead for as long as the current `exec_command` keeps running
  // (apt-get install can easily take 30–60s). It resets to false when
  // state.installing flips off (cancel observed, install done, or error).
  const [cancelling, setCancelling] = useState(false);

  // ── T-03: cleanup delayed by 200ms after close (matches Modal exit animation) ──
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      setPortInput("");
      setCopied(false);
      setPortError(null);
      setCancelling(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // Reset local cancelling state when install loop exits (cancel observed,
  // install completed, or error). Prevents «Отменяем…» from getting stuck
  // if the user reopens the modal during the same session.
  useEffect(() => {
    if (!state.installing) setCancelling(false);
  }, [state.installing]);

  // ── Default port generation on first open when not installed ──
  // portInput excluded from deps intentionally — fires only when isOpen/installed flips
  // (the "initialize on open" pattern). Including portInput would re-fire on every keystroke.
  useEffect(() => {
    if (isOpen && !state.status?.installed && portInput === "") {
      const randomPort = 1024 + Math.floor(Math.random() * (65535 - 1024));
      setPortInput(String(randomPort));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

      {/* Phase 17.1 D-4.3 — legacy migration banner (Option B per researcher).
          Backend emit'ил `mtproto-install-step` step="cleanup_legacy" с
          непустым `message` → hook сохранил его в legacyMigrationNote.
          Banner информативный, не блокирующий. Рендерится в обоих ветках
          (install + configured), чтобы пользователь увидел сообщение и в
          процессе установки, и сразу после её завершения. */}
      {state.legacyMigrationNote && (
        <ErrorBanner
          severity="info"
          message={state.legacyMigrationNote}
          className="mb-3"
          data-testid="mtproto-legacy-banner"
        />
      )}

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

          {/* Install progress — horizontal bar that advances with each stage
              (UAT 2026-05-20: replaced StepProgress dots with linear bar). */}
          {state.installing && (
            <div className="flex flex-col gap-2">
              <div
                className="relative w-full overflow-hidden rounded-full"
                role="progressbar"
                aria-valuenow={Math.round((state.currentStep / Math.max(state.steps.length - 1, 1)) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={state.steps[state.currentStep]?.label ?? ""}
                style={{
                  height: 8,
                  background: "var(--color-bg-surface)",
                  border: "1px solid var(--color-border)",
                }}
              >
                <span
                  className="absolute top-0 bottom-0 left-0 transition-all duration-500"
                  style={{
                    width: `${Math.round((state.currentStep / Math.max(state.steps.length - 1, 1)) * 100)}%`,
                    background: "var(--color-accent-interactive)",
                    borderRadius: "inherit",
                  }}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-caption" style={{ color: "var(--color-text-secondary)" }}>
                  {state.steps[state.currentStep]?.label ?? ""}
                </p>
                <p className="text-caption text-right" style={{ color: "var(--color-text-muted)" }}>
                  {Math.round((state.currentStep / Math.max(state.steps.length - 1, 1)) * 100)}%
                </p>
              </div>
            </div>
          )}

          {/* Error state — show only the message; retry is folded into footer button */}
          {!state.installing && state.error && (
            <p
              className="text-body-sm"
              style={{ color: "var(--color-status-error)" }}
            >
              {state.error}
            </p>
          )}
        </div>
      )}

      {/* Configured view — shown when installed */}
      {installed && (
        <div className="space-y-3">
          {/* Status row — UAT 2026-05-21: when service installed but not active,
              show «Сервис остановлен» banner with diagnostic hint above port row. */}
          {!state.status?.active && (
            <div
              className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] text-body-sm"
              style={{
                backgroundColor: "var(--color-warning-tint-08)",
                border: "1px solid var(--color-status-connecting-border)",
                color: "var(--color-text-secondary)",
              }}
              data-testid="mtproto-stopped-banner"
            >
              <Square
                className="w-4 h-4 shrink-0 mt-0.5"
                style={{ color: "var(--color-warning-500)" }}
                aria-hidden="true"
              />
              <span>{t("server.utilities.mtproto.stopped_hint")}</span>
            </div>
          )}

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

          {/* Actions row — UAT 2026-05-21: Start/Stop toggle prepended.
              Start = primary accent (call to action when not active);
              Stop = secondary (less prominent when service is fine). */}
          <div className="flex flex-wrap items-center gap-2">
            {state.status?.active ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Square className="w-3.5 h-3.5" />}
                loading={state.toggling}
                disabled={state.toggling || state.uninstalling}
                onClick={() => void state.stop()}
                data-testid="mtproto-stop-button"
              >
                {t("server.utilities.mtproto.stop")}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon={<Play className="w-3.5 h-3.5" />}
                loading={state.toggling}
                disabled={state.toggling || state.uninstalling}
                onClick={() => void state.start()}
                data-testid="mtproto-start-button"
              >
                {t("server.utilities.mtproto.start")}
              </Button>
            )}
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
              disabled={state.uninstalling || state.toggling}
              onClick={() => void handleUninstall()}
            >
              {t("server.utilities.mtproto.uninstall")}
            </Button>
          </div>
        </div>
      )}

      {/* Footer — Install / Retry button (when !installed) or Close button.
          UAT 2026-05-20:
            — state.error → primary becomes «Повторить» (state.retry),
            — state.installing → primary hidden, secondary becomes «Отменить»
              (state.cancelInstall — sets backend AppState flag, install loop
              returns at next checkpoint),
            — otherwise → «Установить» (handleInstall). */}
      <div className="flex justify-end gap-2 mt-4">
        {!installed && !state.installing && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              if (state.error) {
                void state.retry(parseInt(portInput, 10) || 0);
              } else {
                void handleInstall();
              }
            }}
            data-testid="mtproto-install-button"
          >
            {state.error
              ? t("server.utilities.mtproto.retry")
              : t("server.utilities.mtproto.install")}
          </Button>
        )}
        {state.installing ? (
          <Button
            variant="danger-outline"
            size="sm"
            disabled={cancelling}
            icon={cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}
            onClick={() => {
              setCancelling(true);
              void state.cancelInstall();
            }}
            data-testid="mtproto-cancel-install-button"
          >
            {cancelling
              ? t("server.utilities.mtproto.cancelling")
              : t("server.utilities.mtproto.cancel_install")}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("buttons.close")}
          </Button>
        )}
      </div>
    </Modal>
  );
}
