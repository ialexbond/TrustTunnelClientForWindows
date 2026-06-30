import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Send, Trash2, Loader2, Play, Square, Copy } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { Tooltip } from "../../shared/ui/Tooltip";
import { cn } from "../../shared/lib/cn";
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

  // Extract optional-chain reads to a local const so the React Compiler
  // dep inference matches the manually-specified useCallback deps below.
  // Mirrors commit 586110cf (`fix(lint): MtProtoSection — extract proxyLink
  // to match React Compiler dep`) which solved the exact same
  // `react-hooks/preserve-manual-memoization` conflict in the section.
  // Keeps the deps array a single token list (`[proxyLink, ...]`) instead
  // of the chain `[state.status?.proxy_link, ...]`.
  const proxyLink = state.status?.proxy_link;

  // E-14 (09-08): shared port-range guard. Returns the validated port number,
  // or null after setting portError. Both the install path AND the retry path
  // MUST go through this — previously retry called
  // state.retry(parseInt(portInput,10) || 0), which sent port 0 on an empty
  // field, bypassing this validation.
  const validatePort = useCallback((): number | null => {
    const parsed = parseInt(portInput, 10);
    if (isNaN(parsed) || parsed < 1024 || parsed > 65535) {
      setPortError(t("server.service.mtproto.port_validation_error"));
      return null;
    }
    setPortError(null);
    return parsed;
  }, [portInput, t]);

  const handleInstall = useCallback(async () => {
    const parsed = validatePort();
    if (parsed === null) return;
    // D-29: log only metadata (host + port number) — NEVER password or secret
    log("STATE", `mtproto.install.start host=${sshParams.host} port=${parsed}`);
    await state.install(parsed);
  }, [validatePort, sshParams.host, state, log]);

  const handleRetry = useCallback(() => {
    // E-14: validate before retrying — never pass parseInt(...) || 0.
    const parsed = validatePort();
    if (parsed === null) return;
    void state.retry(parsed);
  }, [validatePort, state]);

  const handleUninstall = useCallback(async () => {
    // D-29: log only metadata — NEVER password
    log("STATE", `mtproto.uninstall.start host=${sshParams.host}`);
    await state.requestUninstall();
  }, [sshParams.host, state, log]);

  const handleCopy = useCallback(async () => {
    if (!proxyLink) return;
    try {
      await navigator.clipboard.writeText(proxyLink);
      // D-29: log only event metadata — NEVER log proxy_link (contains MTProto secret)
      log("USER", `mtproto.link.copied host=${sshParams.host}`);
      pushSnack(t("server.users.link_copied"));
    } catch {
      // clipboard write may fail in restrictive WebView contexts; silent.
    }
  }, [proxyLink, sshParams.host, log, pushSnack, t]);

  const installed = state.status?.installed ?? false;

  // T-03: NEVER `if (!isOpen) return null` — Modal primitive owns 200ms exit animation
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" showCloseButton>
      {/* Header — the corner × now comes from Modal (showCloseButton, 09-25);
          this row keeps only the icon + title above the content. */}
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
          variant="info"
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
              {proxyLink ? (
                // Owner UAT: single-line read-only field + a copy ICON button,
                // reusing the canonical copyable-link pattern from UserConfigModal
                // (deeplink field) verbatim — readonly <input> that selects all on
                // focus, with an absolutely-positioned Copy button in the right
                // slot. Replaces the old multi-line click-anywhere <code> block.
                <div className="relative">
                  <input
                    type="text"
                    readOnly
                    value={proxyLink}
                    aria-label={t("server.service.mtproto.proxy_link_label")}
                    onFocus={(e) => e.currentTarget.select()}
                    className={cn(
                      "h-8 w-full pl-3 pr-10 text-sm font-mono rounded-[var(--radius-md)]",
                      "border border-[var(--color-input-border)]",
                      "bg-[var(--color-input-bg)]",
                      "text-[var(--color-text-primary)]",
                      "outline-none",
                      "focus-visible:border-[var(--color-input-focus)] focus-visible:shadow-[var(--focus-ring)]",
                    )}
                    data-testid="mtproto-proxy-link"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center leading-none">
                    <Tooltip text={t("server.service.mtproto.copy")}>
                      <button
                        type="button"
                        aria-label={t("server.service.mtproto.copy")}
                        onClick={() => void handleCopy()}
                        className={cn(
                          "p-1 rounded flex items-center",
                          "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
                          "focus-visible:shadow-[var(--focus-ring)] outline-none",
                          "transition-[color,transform] duration-[var(--transition-fast)]",
                          "active:scale-[0.92]",
                        )}
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
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

      {/* Footer — modal-footer standard (09-25, owner §6):
          - installed (configured view): content-width, right-aligned. The
            corner × replaces the old labeled «Закрыть» (F18). Left→right:
            [Удалить (danger-outline)] then the primary slot [Stop/Start].
            «Остановить» = solid danger (red), «Запустить» = solid primary
            (teal) — both real actions, sharing one slot (owner §6.4).
          - !installed: Install/Retry primary on the right; the corner × is the
            close affordance (the idle «Закрыть» ghost was dropped). The
            cancel-install danger-outline stays while installing — a real
            action, not a redundant close. */}
      {installed ? (
        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="danger-outline"
            size="sm"
            icon={<Trash2 className="w-3.5 h-3.5" />}
            loading={state.uninstalling}
            disabled={state.uninstalling || state.toggling}
            onClick={() => void handleUninstall()}
          >
            {t("server.service.mtproto.uninstall")}
          </Button>
          {state.status?.active ? (
            <Button
              variant="danger"
              size="sm"
              icon={<Square className="w-3.5 h-3.5" />}
              loading={state.toggling}
              disabled={state.toggling || state.uninstalling}
              onClick={() => void state.stop()}
              data-testid="mtproto-stop-button"
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
            >
              {t("server.service.mtproto.start")}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex justify-end gap-2 mt-4">
          {!state.installing && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                if (state.error) {
                  handleRetry();
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
          {state.installing && (
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
          )}
        </div>
      )}
    </Modal>
  );
}
