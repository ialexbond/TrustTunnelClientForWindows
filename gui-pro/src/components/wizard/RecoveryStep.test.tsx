import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { RecoveryStep } from "./RecoveryStep";
import { renderWithProviders as render } from "../../test/test-utils";
import { makeWizardState } from "./testHelpers";
import type { ServerProbe } from "./resolveResume";

function probe(over?: Partial<ServerProbe>): ServerProbe {
  return {
    installed: true,
    binaryInstalled: true,
    credentialsExist: true,
    rulesExist: true,
    vpnConfigExists: true,
    hostsConfigExists: true,
    certPresent: true,
    unitExists: true,
    unitEnabled: false,
    serviceActive: false,
    partial: true,
    configDiverges: false,
    localExportComplete: false,
    ...over,
  };
}

describe("RecoveryStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  // ─── Partial-install fork (Continue / Start over) ───────────────────

  it("renders the recovery title and Continue + Start over buttons", () => {
    const w = makeWizardState({ step: "recovery", recoveryProbe: probe() });
    render(<RecoveryStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.recovery.title"))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18n.t("wizard.recovery.continue") }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18n.t("wizard.recovery.startOver") }),
    ).toBeInTheDocument();
  });

  it("Continue (safe default) invokes handleContinue (re-runs probe + resolveResume)", () => {
    const handleContinue = vi.fn();
    const w = makeWizardState({ step: "recovery", recoveryProbe: probe(), handleContinue });
    render(<RecoveryStep {...w} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("wizard.recovery.continue") }));
    expect(handleContinue).toHaveBeenCalledOnce();
  });

  it("Start over (destructive) opens a confirm dialog before running handleStartOver", async () => {
    // T-06-08: the destructive Start over (= EXTENDED full uninstall) must go through
    // a danger confirm gate — never a bare click. Clicking shows the dialog; the
    // handler only fires on explicit confirm.
    const handleStartOver = vi.fn();
    const w = makeWizardState({ step: "recovery", recoveryProbe: probe(), handleStartOver });
    render(<RecoveryStep {...w} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("wizard.recovery.startOver") }));
    // Dialog with the UI-SPEC irreversible-consequence copy appears.
    expect(
      await screen.findByText(i18n.t("wizard.recovery.startOverConfirm_title")),
    ).toBeInTheDocument();
    // Not yet called — the gate is in front of the action.
    expect(handleStartOver).not.toHaveBeenCalled();
    // Confirm → the same handler runs unchanged.
    fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.delete") }));
    await new Promise((r) => setTimeout(r, 0));
    expect(handleStartOver).toHaveBeenCalledOnce();
  });

  it("D-18: Start over confirm shows the plain-language «что будет удалено (только наше)» cocoon list + «НЕ трогаем» line", async () => {
    // 06-17 D-18: the EXISTING confirm message is enriched (copy-only) with the
    // ownership-scoped cocoon list so a non-technical user sees the bounded
    // «only our files» boundary before the destructive action.
    const handleStartOver = vi.fn();
    const w = makeWizardState({ step: "recovery", recoveryProbe: probe(), handleStartOver });
    render(<RecoveryStep {...w} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("wizard.recovery.startOver") }));
    // The dialog opens with the enriched RU copy: a distinctive list item and the
    // «системные пакеты … НЕ трогаем» boundary line. The ConfirmDialog renders the
    // message with whitespace-pre-line, so the \n-list lives in one text node — match
    // on a substring via a function matcher.
    const msg = await screen.findByText(
      (content) =>
        content.includes("правило фаервола, которое мы добавили") &&
        content.includes("Системные пакеты (curl, certbot)") &&
        content.includes("НЕ трогаем"),
    );
    expect(msg).toBeInTheDocument();
    // No SSH host/path/secret shown verbatim (D-29): the copy names categories only.
    expect(msg).not.toHaveTextContent("/opt/trusttunnel");
  });

  it("Start over confirm dialog can be cancelled without running handleStartOver", async () => {
    const handleStartOver = vi.fn();
    const w = makeWizardState({ step: "recovery", recoveryProbe: probe(), handleStartOver });
    render(<RecoveryStep {...w} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("wizard.recovery.startOver") }));
    const cancelBtn = await screen.findByRole("button", { name: i18n.t("buttons.cancel") });
    fireEvent.click(cancelBtn);
    await new Promise((r) => setTimeout(r, 0));
    expect(handleStartOver).not.toHaveBeenCalled();
  });

  // ─── Apply-my-settings ONLY when configDiverges (round-2 finding C) ──

  it("does NOT render 'apply my settings' when configDiverges is false", () => {
    const w = makeWizardState({
      step: "recovery",
      recoveryProbe: probe({ configDiverges: false }),
    });
    render(<RecoveryStep {...w} />);
    expect(
      screen.queryByRole("button", { name: i18n.t("wizard.recovery.applySettings") }),
    ).not.toBeInTheDocument();
  });

  it("renders 'apply my settings' ONLY when configDiverges is true", () => {
    const handleApplyConfig = vi.fn();
    const w = makeWizardState({
      step: "recovery",
      recoveryProbe: probe({ configDiverges: true }),
      handleApplyConfig,
    });
    render(<RecoveryStep {...w} />);
    const btn = screen.getByRole("button", { name: i18n.t("wizard.recovery.applySettings") });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(handleApplyConfig).toHaveBeenCalledOnce();
  });

  // ─── Host-key-changed fork (D-09, Gemini #11 + finding B) ────────────

  it("shows the 'trust the new key' affordance on the SSH_HOST_KEY_CHANGED cause", () => {
    const handleTrustNewKey = vi.fn();
    const w = makeWizardState({
      step: "recovery",
      recoveryCause: "SSH_HOST_KEY_CHANGED",
      handleTrustNewKey,
    });
    render(<RecoveryStep {...w} />);
    expect(
      screen.getByText(i18n.t("wizard.recovery.hostKeyChanged.title")),
    ).toBeInTheDocument();
    const trustBtn = screen.getByRole("button", {
      name: i18n.t("wizard.recovery.hostKeyChanged.trust"),
    });
    fireEvent.click(trustBtn);
    expect(handleTrustNewKey).toHaveBeenCalledOnce();
    // The partial-install fork is NOT shown in the host-key-changed branch.
    expect(
      screen.queryByRole("button", { name: i18n.t("wizard.recovery.continue") }),
    ).not.toBeInTheDocument();
  });

  it("the host-key-changed branch does NOT show Start over (the partial fork)", () => {
    const w = makeWizardState({
      step: "recovery",
      recoveryCause: "SSH_HOST_KEY_CHANGED",
    });
    render(<RecoveryStep {...w} />);
    expect(
      screen.queryByRole("button", { name: i18n.t("wizard.recovery.startOver") }),
    ).not.toBeInTheDocument();
  });
});
