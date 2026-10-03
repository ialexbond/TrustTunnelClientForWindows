import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import {
  useUpdateProgress,
  UI_STEPS,
  type SshParams,
} from "./useUpdateProgress";

/**
 * UpdateProgressModal — Phase 18 Plan 06.
 *
 * Modal compound для ProtocolUpdateSection-triggered sidecar update flow (Phase 19).
 * Pattern reference: MtProtoModal (Phase 17). T-03 invariant strict.
 *
 * Backend контракт (Plan 18-05):
 *   - invoke('update_sidecar', { ... params, targetVersion }) — pipeline
 *   - listen('update-protocol-step') — progress events
 *   - invoke('cancel_update_sidecar') — cancel capability (НЕ used в UI per
 *     UI-SPEC D-DECISION-UI-4.1; backend cancel сохранён для Phase 19 polish)
 *
 * UI-SPEC compliance:
 *   - 4 UI steps (UI-SPEC D-DECISION-UI-4.2): download / backup / apply / verify
 *   - Linear progress bar (D-DECISION-UI-4.3, НЕ StepProgress dots)
 *   - Active state: НЕ closable (closeOnBackdrop=false, closeOnEscape=false,
 *     no X button) — D-DECISION-UI-4.1
 *   - Success state: setTimeout(300) → onSuccess + onClose, SnackBar handled
 *     by parent (D-DECISION-UI-4.4)
 *   - Error state: 3-line copy + Закрыть button + closeOnBackdrop=true
 *     (D-DECISION-UI-4.5)
 *
 * D-29 invariant (security):
 *   - sshParams.password НИКОГДА в displayed text либо log
 *   - backend payload.message — opaque i18n key либо metadata, NEVER displayed
 *     verbatim (Modal показывает только canonical t('app.update.modal.step_*'))
 *   - React JSX auto-escapes user-controlled content
 *
 * Accessibility:
 *   - role="dialog" + aria-modal="true" + aria-labelledby="update-modal-title"
 *     EXPLICITLY added в wrapper div (Modal primitive не имеет built-in per
 *     UI-SPEC §Accessibility).
 *   - role="progressbar" + aria-valuenow/min/max на linear bar.
 *
 * T-03 (Modal lifecycle):
 *   - НИКОГДА не делать `if (!isOpen) return null` перед <Modal>
 *   - Cleanup local state через setTimeout(200) — после exit animation
 *   - Reuse MtProtoModal canonical pattern
 */

export interface UpdateProgressModalProps {
  isOpen: boolean;
  onClose: () => void;
  sshParams: SshParams;
  fromVersion: string;
  toVersion: string;
  onSuccess: () => void;
  onError?: (errorCode: string) => void;
}

export function UpdateProgressModal({
  isOpen,
  onClose,
  sshParams,
  fromVersion,
  toVersion,
  onSuccess,
  onError,
}: UpdateProgressModalProps) {
  const { t } = useTranslation();
  const { state, startUpdate, reset } = useUpdateProgress();

  // ─── T-03: cleanup local state delayed by 200ms after close ──
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      reset();
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen, reset]);

  // ─── Start update on open (idempotent — only fires when idle) ──
  useEffect(() => {
    if (isOpen && state.phase === "idle") {
      void startUpdate(sshParams, toVersion).catch((e) => {
        // D-29: НЕ логируем sshParams — useUpdateProgress handles error sanitization
        console.warn("[UpdateProgressModal] startUpdate threw:", String(e));
      });
    }
  }, [isOpen, state.phase, startUpdate, sshParams, toVersion]);

  // ─── On success: auto-close + notify parent (300ms delay D-DECISION-UI-4.4) ──
  useEffect(() => {
    if (state.phase === "success") {
      const timer = setTimeout(() => {
        onSuccess();
        onClose();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [state.phase, onSuccess, onClose]);

  // ─── On error: notify parent (modal остаётся открытой) ──
  useEffect(() => {
    if (state.phase === "error" && state.errorCode && onError) {
      onError(state.errorCode);
    }
  }, [state.phase, state.errorCode, onError]);

  // ─── Lookup current UI step key (fallback to first step) ──
  const uiStepKey = UI_STEPS[state.currentStep] ?? "download";

  // ─── Title + icon by phase ──
  const titleText =
    state.phase === "error"
      ? t("app.update.modal.title_error")
      : t("app.update.modal.title_active");

  // Owner UAT: the error phase has NO title icon — the app has no red/iconed error
  // modals, so the error reads from the copy, not a danger glyph. Active phase keeps
  // its spinning RefreshCw.
  const titleIcon =
    state.phase === "error" ? null : (
      <RefreshCw
        className="w-5 h-5 shrink-0 animate-spin"
        style={{ color: "var(--color-accent-interactive)" }}
        aria-hidden="true"
      />
    );

  // ─── Error copy: cancelled (UPDATE_CANCELLED) vs generic (verify-timeout/etc) ──
  const isCancelled = state.errorCode === "UPDATE_CANCELLED";
  const errorLine1 = isCancelled
    ? t("app.update.modal.cancelled_line_1")
    : t("app.update.modal.error_line_1");
  const errorLine2 = isCancelled
    ? t("app.update.modal.cancelled_line_2")
    : t("app.update.modal.error_line_2");
  const errorLine3 = isCancelled
    ? t("app.update.modal.cancelled_line_3", { from: fromVersion })
    : t("app.update.modal.error_line_3", { from: fromVersion });

  // ─── Active state: no backdrop/escape close (D-DECISION-UI-4.1) ──
  //     Error state: allow close.
  //     Success state: modal closes automatically — closeable as safety net.
  const canCloseFreely = state.phase !== "active";

  // T-03: NEVER `if (!isOpen) return null` — Modal primitive owns 200ms exit animation
  return (
    <Modal
      isOpen={isOpen}
      // Active state intercepts close attempts (UI-SPEC: no X / backdrop /
      // escape closure during operation). Other phases pass-through.
      onClose={canCloseFreely ? onClose : () => {}}
      size="md"
      closeOnBackdrop={canCloseFreely}
      closeOnEscape={canCloseFreely}
      // Owner UAT: when the modal CAN be closed (error / done — NEVER during the
      // active update), also show the corner X as the standard duplicate close
      // affordance alongside the «Закрыть» button (design-system convention).
      showCloseButton={canCloseFreely}
    >
      {/* EXPLICIT aria — per UI-SPEC §Accessibility, Modal primitive не имеет built-in */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
        className="space-y-3"
        data-testid="update-progress-modal"
      >
        <h2
          id="update-modal-title"
          className="text-title flex items-center gap-2"
          // Owner UAT: the error modal uses the SAME neutral title as every other
          // modal (text-primary) — no red, no icon. Error reads from the copy.
          style={{ color: "var(--color-text-primary)" }}
        >
          {titleIcon}
          {titleText}
        </h2>

        {state.phase !== "error" && (
          <>
            <p
              className="text-body"
              style={{ color: "var(--color-text-secondary)" }}
              data-testid="update-modal-current-step-label"
            >
              {t(`app.update.modal.step_${uiStepKey}`)}
            </p>

            {/* Linear progress bar (UI-SPEC D-DECISION-UI-4.3 — Phase 17.1 post-UAT pattern) */}
            <div
              className="relative w-full overflow-hidden rounded-full"
              role="progressbar"
              aria-valuenow={Math.round(state.percent)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t(`app.update.modal.step_${uiStepKey}`)}
              style={{
                height: 8,
                background: "var(--color-bg-surface)",
                border: "1px solid var(--color-border)",
              }}
            >
              <span
                className="absolute top-0 bottom-0 left-0 transition-all duration-500"
                style={{
                  width: `${Math.round(state.percent)}%`,
                  background: "var(--color-accent-interactive)",
                  borderRadius: "inherit",
                }}
              />
            </div>

            {/* Step counter + version transition */}
            <div
              className="flex items-center justify-between text-caption"
              style={{ color: "var(--color-text-muted)" }}
            >
              <span>
                {t("app.update.modal.step_counter", {
                  current: state.currentStep + 1,
                  label: t(`app.update.modal.step_${uiStepKey}`),
                })}
              </span>
              <span
                className="text-mono-sm"
                style={{ color: "var(--color-text-primary)" }}
              >
                {t("app.update.modal.version_transition", {
                  from: fromVersion,
                  to: toVersion,
                })}
              </span>
            </div>
          </>
        )}

        {state.phase === "error" && (
          // Owner UAT: plain neutral body (no red banner) — ONE flowing paragraph
          // (not a line-per-sentence stack) so the modal stays compact.
          <p
            className="text-body"
            style={{ color: "var(--color-text-secondary)" }}
            data-testid="update-modal-error-block"
          >
            {`${errorLine1} ${errorLine2} ${errorLine3}`}
          </p>
        )}

        {/* Footer — error phase only (active phase intentionally has no
            actionable footer per UI-SPEC D-DECISION-UI-4.1) */}
        {state.phase === "error" && (
          <div
            className="flex justify-end pt-2"
            data-testid="update-modal-footer"
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={onClose}
              data-testid="update-modal-close"
            >
              {t("app.update.modal.close")}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
