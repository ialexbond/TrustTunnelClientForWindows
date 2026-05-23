import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Send, Trash2, Loader2, Play, Square } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { NumberInput, Skeleton } from "../../shared/ui";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
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
  const pushSnack = useSnackBar();

  // ── Local form state ──
  const [portInput, setPortInput] = useState<string>("");
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

  // ── Default port on first open when not installed ──
  // Phase 17.1 (D-2.3 / D-2.4): default 8443 per mtproto-org/proxy guide.
  // 443 занят sidecar TrustTunnel; 8443 — стандартный TLS-camouflage port для telemt.
  // Пользователь может ввести свой port (validation 1024-65535 в backend).
  // portInput excluded from deps intentionally — fires only when isOpen/installed flips
  // (the "initialize on open" pattern). Including portInput would re-fire on every keystroke.
  useEffect(() => {
    if (isOpen && !state.status?.installed && portInput === "") {
      setPortInput("8443");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, state.status?.installed]);

  // ── Handlers ──

  const handleInstall = useCallback(async () => {
    const parsed = parseInt(portInput, 10);
    if (isNaN(parsed) || parsed < 1024 || parsed > 65535) {
      setPortError(t("server.service.mtproto.port_validation_error"));
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
    try {
      await navigator.clipboard.writeText(link);
      // D-29: log only event metadata — NEVER log proxy_link (contains MTProto secret)
      log("USER", `mtproto.link.copied host=${sshParams.host}`);
      pushSnack(t("server.users.link_copied"));
    } catch {
      // clipboard write may fail in restrictive WebView contexts; silent.
    }
  }, [state.status?.proxy_link, sshParams.host, log, pushSnack, t]);

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
            ? t("server.service.mtproto.modal_title_configure")
            : t("server.service.mtproto.modal_title_install")}
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
            {t("server.service.mtproto.empty_hint")}
          </p>

          <div>
            <label
              className="text-caption block mb-1"
              style={{ color: "var(--color-text-muted)" }}
            >
              {t("server.service.mtproto.port_label")}
            </label>
            <NumberInput
              value={portInput}
              onChange={setPortInput}
              min={1024}
              max={65535}
              placeholder={t("server.service.mtproto.port_placeholder")}
              disabled={state.installing}
              aria-label={t("server.service.mtproto.port_label")}
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
              <span>{t("server.service.mtproto.stopped_hint")}</span>
            </div>
          )}

          {/* Port display row */}
          <div
            className="flex items-center justify-between gap-3 py-2 border-b"
            style={{ borderColor: "var(--color-border)" }}
          >
            <span className="text-body-sm" style={{ color: "var(--color-text-secondary)" }}>
              {t("server.service.mtproto.port_label")}
            </span>
            <span className="text-mono-sm" style={{ color: "var(--color-text-primary)" }}>
              {state.status?.port}
            </span>
          </div>

          {/* Proxy link display — Phase 17.1 post-UAT 2026-05-21:
              clickable area, click → copy + snackbar. Copy button removed.
              Если ссылка ещё не получена (telemt подтягивает IP) — skeleton
              с подсказкой, фоновый polling в useMtProtoState подхватит её. */}
          {state.status?.active && (
            <div>
              <p
                className="text-caption mb-1"
                style={{ color: "var(--color-text-muted)" }}
              >
                {t("server.service.mtproto.proxy_link_label")}
              </p>
              {state.status?.proxy_link ? (
                // UAT 2026-05-23: aligned the readonly-link block with the
                // canonical copyable-link pattern from UserConfigModal —
                // neutral input-style surface (input-bg + input-border) with
                // text-primary content, instead of the accent-tinted look
                // that was reading as a status/success colour. Still
                // click-anywhere-to-copy (preserves the multi-line wrap UX
                // that a single-line <input> can't give for the long
                // tg://proxy?... payload).
                <code
                  role="button"
                  tabIndex={0}
                  aria-label={t("server.service.mtproto.copy")}
                  onClick={() => void handleCopy()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void handleCopy();
                    }
                  }}
                  className="text-mono-sm break-all block py-2 px-3 rounded-[var(--radius-md)] cursor-pointer transition-colors hover:bg-[var(--color-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-interactive)]"
                  style={{
                    color: "var(--color-text-primary)",
                    backgroundColor: "var(--color-input-bg)",
                    border: "1px solid var(--color-input-border)",
                  }}
                  data-testid="mtproto-proxy-link"
                >
                  {state.status.proxy_link}
                </code>
              ) : (
                <div
                  className="block py-2 px-3 rounded-[var(--radius-md)] space-y-1.5"
                  style={{ backgroundColor: "var(--color-bg-secondary)" }}
                  data-testid="mtproto-proxy-link-skeleton"
                  aria-busy="true"
                  aria-live="polite"
                >
                  <Skeleton variant="line" width="92%" height={14} />
                  <Skeleton variant="line" width="78%" height={14} />
                  <p
                    className="text-caption mt-1"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {t("server.service.mtproto.fetching_link")}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Footer — Phase 17.1 post-UAT 2026-05-21:
          - installed (configured view): 3 кнопки в одну строку на всю ширину
            (Удалить | Start/Stop | Закрыть) — user-requested order 2026-05-21
          - !installed: Install/Retry + Close (или Cancel пока installing) */}
      {installed ? (
        <div className="grid grid-cols-3 gap-2 mt-4">
          <Button
            variant="danger-outline"
            size="sm"
            icon={<Trash2 className="w-3.5 h-3.5" />}
            loading={state.uninstalling}
            disabled={state.uninstalling || state.toggling}
            onClick={() => void handleUninstall()}
            className="w-full"
          >
            {t("server.service.mtproto.uninstall")}
          </Button>
          {state.status?.active ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Square className="w-3.5 h-3.5" />}
              loading={state.toggling}
              disabled={state.toggling || state.uninstalling}
              onClick={() => void state.stop()}
              data-testid="mtproto-stop-button"
              className="w-full"
            >
              {t("server.service.mtproto.stop")}
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
              className="w-full"
            >
              {t("server.service.mtproto.start")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="w-full"
          >
            {t("buttons.close")}
          </Button>
        </div>
      ) : (
        <div className="flex justify-end gap-2 mt-4">
          {!state.installing && (
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
                ? t("server.service.mtproto.retry")
                : t("server.service.mtproto.install")}
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
                ? t("server.service.mtproto.cancelling")
                : t("server.service.mtproto.cancel_install")}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("buttons.close")}
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}
