import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronRight, Trash2, RefreshCw, KeyRound } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialogContext } from "../../shared/ui/ConfirmDialogProvider";
import { StepBar } from "./StepBar";
import type { WizardState } from "./useWizardState";

// ─── RecoveryStep — the recovery fork (WIZARD-03, D-01/D-04/D-09) ──────────────
//
// A half-installed server is NEVER a dead end and is NEVER silently auto-resumed
// (D-01). When resolveResume lands on `recovery`, this screen presents an EXPLICIT
// fork:
//   • Continue (safe default, primary) — re-runs the probe + resolveResume in the
//     hook (handleContinue) so the destination is whatever the server reality
//     resolves to (round-2 finding E), NOT a hard-coded step.
//   • Start over (destructive, secondary) — runs the EXTENDED full-clean
//     uninstall_server (D-04, ownership-scoped firewall removal — round-3 HIGH A)
//     and resets the wizard to welcome.
//   • Apply my settings (shown ONLY when the probe reports configDiverges) —
//     re-configures via deploy_server(overwrite_config=true), the REAL command
//     (round-3 LOW C); credentials.toml is always preserved (D-02, finding C).
//
// When the recovery cause is SSH_HOST_KEY_CHANGED (a reinstalled server whose host
// key changed — Gemini #11 + round-2 finding B), the screen instead shows the
// "trust the new key" affordance. Trust is EXPLICIT-only — the old silent
// auto-forget is removed (D-09); only this action forgets the old key and re-TOFUs.
//
// Re-skinned onto the v3.0 onboarding hero language (D-05; UI-SPEC "Recovery" row +
// PATTERNS §D): 64px hero square + .text-display-sm heading + .text-body desc. The
// Phase-5 fork behavior is UNCHANGED — each button still calls the same handler. The
// ONLY behavioral addition is the destructive confirm gate in front of "Начать заново"
// (Start over = the EXTENDED full uninstall): it now goes through useConfirm/
// ConfirmDialog (variant="danger") with the UI-SPEC irreversible-consequence copy, never
// a bare click (T-06-08 mitigation). Token color classes only; no inline style/hex.
export function RecoveryStep(w: WizardState) {
  const { t } = useTranslation();
  // Read the confirm context directly (not the useConfirm hook, which THROWS when no
  // provider is mounted). In production App.tsx always wraps the wizard in
  // ConfirmDialogProvider, so `confirm` is present and the danger dialog shows. The
  // bare-mount invariance suite (wizard.mount-resume.test.tsx — MUST stay untouched)
  // renders <SetupWizard/> without the provider purely to assert resume-resolution;
  // there `confirm` is null and we fall back to the handler directly so that test
  // still mounts the recovery screen without crashing.
  const confirm = useContext(ConfirmDialogContext);
  const busy = w.recoveryBusy;

  // Start over is destructive + irreversible (full uninstall). Gate it behind the
  // confirm dialog; on confirm, call the same handleStartOver handler unchanged.
  const handleStartOverPrompt = async () => {
    if (!confirm) {
      // No provider mounted (bare invariance harness only) — preserve the action.
      w.handleStartOver();
      return;
    }
    const ok = await confirm({
      title: t("wizard.recovery.startOverConfirm_title"),
      message: t("wizard.recovery.startOverConfirm_message"),
      variant: "danger",
      confirmText: t("buttons.delete"),
      cancelText: t("buttons.cancel"),
    });
    if (!ok) return;
    w.handleStartOver();
  };

  // Host-key-changed branch (D-09): a reinstalled server. Explicit trust only.
  if (w.recoveryCause === "SSH_HOST_KEY_CHANGED") {
    return (
      <>
        <StepBar step={w.step} />
        <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
          <div className="max-w-sm w-full text-center space-y-5 my-auto">
            <div className="mx-auto w-16 h-16 rounded-[var(--radius-xl)] flex items-center justify-center bg-[var(--color-status-connecting-bg)]">
              <KeyRound className="w-8 h-8 text-[var(--color-warning-500)]" />
            </div>
            <div className="space-y-1.5">
              <h2 id="wizard-heading" className="text-display-sm text-[var(--color-warning-500)]">
                {t("wizard.recovery.hostKeyChanged.title")}
              </h2>
              <p className="text-body text-[var(--color-text-secondary)]">
                {t("wizard.recovery.hostKeyChanged.explain")}
              </p>
            </div>
            <div className="space-y-2 pt-1">
              <Button
                variant="primary"
                size="sm"
                fullWidth
                loading={busy}
                disabled={busy}
                icon={<KeyRound className="w-4 h-4" />}
                onClick={() => w.handleTrustNewKey()}
              >
                {busy ? t("wizard.recovery.working") : t("wizard.recovery.hostKeyChanged.trust")}
              </Button>
              <p className="text-body-sm text-[var(--color-text-muted)]">
                {t("wizard.recovery.hostKeyChanged.trust_hint")}
              </p>
            </div>
            <Button variant="ghost" size="sm" fullWidth disabled={busy} onClick={() => w.onClose?.()}>
              {t("buttons.back")}
            </Button>
          </div>
        </div>
      </>
    );
  }

  // Standard recovery fork: Continue (safe default) / Start over (destructive)
  // + Apply my settings (only when configDiverges).
  const showApplySettings = !!w.recoveryProbe?.configDiverges;

  return (
    <>
      <StepBar step={w.step} />
      <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
        <div className="max-w-sm w-full text-center space-y-5 my-auto">
          <div className="mx-auto w-16 h-16 rounded-[var(--radius-xl)] flex items-center justify-center bg-[var(--color-status-connecting-bg)]">
            <AlertTriangle className="w-8 h-8 text-[var(--color-warning-500)]" />
          </div>
          <div className="space-y-1.5">
            <h2 id="wizard-heading" className="text-display-sm text-[var(--color-warning-500)]">
              {t("wizard.recovery.title")}
            </h2>
            <p className="text-body text-[var(--color-text-secondary)]">
              {t("wizard.recovery.explain")}
            </p>
          </div>

          <div className="space-y-3 pt-1 text-left">
            {/* Continue — primary, safe default (re-runs probe + resolveResume). */}
            <div className="space-y-1">
              <Button
                variant="primary"
                size="sm"
                fullWidth
                loading={busy}
                disabled={busy}
                icon={<ChevronRight className="w-4 h-4" />}
                onClick={() => w.handleContinue()}
              >
                {busy ? t("wizard.recovery.working") : t("wizard.recovery.continue")}
              </Button>
              <p className="text-body-sm text-[var(--color-text-muted)]">
                {t("wizard.recovery.continue_hint")}
              </p>
            </div>

            {/* Apply my settings — ONLY when the probe reports config divergence. */}
            {showApplySettings && (
              <div className="space-y-1">
                <Button
                  variant="secondary"
                  size="sm"
                  fullWidth
                  disabled={busy}
                  icon={<RefreshCw className="w-4 h-4" />}
                  onClick={() => w.handleApplyConfig()}
                >
                  {t("wizard.recovery.applySettings")}
                </Button>
                <p className="text-body-sm text-[var(--color-text-muted)]">
                  {t("wizard.recovery.applySettings_hint")}
                </p>
              </div>
            )}

            {/* Start over — destructive, irreversible. Gated behind a danger confirm
                dialog (T-06-08); on confirm it runs the same handleStartOver. */}
            <div className="space-y-1">
              <Button
                variant="danger"
                size="sm"
                fullWidth
                disabled={busy}
                icon={<Trash2 className="w-4 h-4" />}
                onClick={() => { void handleStartOverPrompt(); }}
              >
                {t("wizard.recovery.startOver")}
              </Button>
              <p className="text-body-sm text-[var(--color-text-muted)]">
                {t("wizard.recovery.startOver_hint")}
              </p>
            </div>
          </div>

          {w.errorMessage && (
            <p className="text-body-sm text-[var(--color-danger-500)]">{w.errorMessage}</p>
          )}
        </div>
      </div>
    </>
  );
}
