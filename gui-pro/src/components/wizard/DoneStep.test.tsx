import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { DoneStep } from "./DoneStep";
import { makeWizardState } from "./testHelpers";

describe("DoneStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders success title", () => {
    const w = makeWizardState({ step: "done" });
    render(<DoneStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.done.title"))).toBeInTheDocument();
  });

  // 06-uat: deploy-only wizard — the Done screen always shows the deploy description
  // (the fetch-completion copy was removed with the fetch flow).
  it("always shows the deploy description", () => {
    const w = makeWizardState({ step: "done" });
    render(<DoneStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.done.deploy_description"))).toBeInTheDocument();
  });

  it("shows config path when configPath is set", () => {
    const w = makeWizardState({ step: "done", configPath: "/home/user/config.toml" });
    render(<DoneStep {...w} />);
    expect(screen.getByText("/home/user/config.toml")).toBeInTheDocument();
  });

  it("renders go-to-panel button and calls onSetupComplete (closes overlay)", () => {
    // D-01 / A3: onSetupComplete already closes the overlay in App — the dead
    // setWizardStep("welcome") preamble is dropped.
    const setWizardStep = vi.fn();
    const onSetupComplete = vi.fn();
    const w = makeWizardState({ step: "done", configPath: "/tmp/c.toml", setWizardStep, onSetupComplete });
    render(<DoneStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.done.go_to_panel")));
    expect(onSetupComplete).toHaveBeenCalledWith("/tmp/c.toml");
    expect(setWizardStep).not.toHaveBeenCalledWith("welcome");
  });

  it("renders go-to-connection button when configPath exists", () => {
    const w = makeWizardState({ step: "done", configPath: "/tmp/c.toml" });
    render(<DoneStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.done.go_to_connection"))).toBeInTheDocument();
  });

  it("renders save-as button when configPath exists and calls handleSaveAs", () => {
    const handleSaveAs = vi.fn();
    const w = makeWizardState({ step: "done", configPath: "/tmp/c.toml", handleSaveAs });
    render(<DoneStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.save_as")));
    expect(handleSaveAs).toHaveBeenCalledOnce();
  });

  it("does not show save-as or connection buttons when configPath is empty", () => {
    const w = makeWizardState({ step: "done", configPath: "" });
    render(<DoneStep {...w} />);
    expect(screen.queryByText(i18n.t("buttons.save_as"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("wizard.done.go_to_connection"))).not.toBeInTheDocument();
  });

  // ── Save-as button flow ──

  it("save-as button is present only when configPath exists", () => {
    const w = makeWizardState({ step: "done", configPath: "/tmp/vpn.toml" });
    render(<DoneStep {...w} />);
    expect(screen.getByText(i18n.t("buttons.save_as"))).toBeInTheDocument();
  });

  // ── Go to connection button ──

  it("go-to-connection button sets localStorage and calls callbacks", () => {
    const setWizardStep = vi.fn();
    const onSetupComplete = vi.fn();
    const w = makeWizardState({
      step: "done",
      configPath: "/tmp/c.toml",
      setWizardStep,
      onSetupComplete,
    });
    render(<DoneStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.done.go_to_connection")));
    // Phase 17 fix-marathon (commit ~e5af18ea..9a11bb0a) bug-fixed
    // DoneStep "Go to connection" to actually route to the `connection`
    // tab instead of `settings` (the old value silently broke navigation
    // because App.tsx validated the target against the AppTab union and
    // rejected anything not in the union).
    expect(localStorage.getItem("tt_navigate_after_setup")).toBe("connection");
    // D-01 / A3: onSetupComplete closes the overlay; no dead welcome navigation.
    expect(onSetupComplete).toHaveBeenCalledWith("/tmp/c.toml");
    expect(setWizardStep).not.toHaveBeenCalledWith("welcome");
  });

  // ── Config file label ──

  it("shows config file label when configPath present", () => {
    const w = makeWizardState({ step: "done", configPath: "/home/user/vpn.toml" });
    render(<DoneStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.done.config_file_label"))).toBeInTheDocument();
  });

  it("does not show config file label when configPath empty", () => {
    const w = makeWizardState({ step: "done", configPath: "" });
    render(<DoneStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.done.config_file_label"))).not.toBeInTheDocument();
  });

  // ── Go-to-panel button always present ──

  it("go-to-panel button is always present even without configPath", () => {
    const w = makeWizardState({ step: "done", configPath: "" });
    render(<DoneStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.done.go_to_panel"))).toBeInTheDocument();
  });

  // UAT #20 (06-uat): the «Адрес сервера» card and the one-time password-reveal card
  // were REMOVED from the Done screen (the generated password lives in the saved .toml;
  // the address + CN note were noise on the success screen). Assert neither is rendered.

  it("does NOT render the one-time password-reveal card (removed UAT #20)", () => {
    const w = makeWizardState({
      step: "done",
      configPath: "/tmp/c.toml",
      vpnPassword: "Gen3ratedPass!",
    });
    render(<DoneStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.done.password_reveal_label"))).not.toBeInTheDocument();
    // The generated value is never put in the DOM here.
    expect(screen.queryByText("Gen3ratedPass!")).not.toBeInTheDocument();
  });

  it("does NOT render the resolved endpoint address card (removed UAT #20)", () => {
    const w = makeWizardState({
      step: "done",
      configPath: "/tmp/c.toml",
      resolvedEndpointAddress: "203.0.113.5:8443",
      selfSignedNoDomain: true,
    });
    render(<DoneStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.done.endpoint_address_label"))).not.toBeInTheDocument();
    expect(screen.queryByText("203.0.113.5:8443")).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("wizard.done.cert_cn_note"))).not.toBeInTheDocument();
  });

  // ── C-09 / D-16 (06-15): soft, dismissable reachability warning ──

  it("shows the soft reachability warning ONLY when reachabilityWarning=true", () => {
    const off = makeWizardState({ step: "done", configPath: "/tmp/c.toml", reachabilityWarning: false });
    const { unmount } = render(<DoneStep {...off} />);
    expect(screen.queryByText(i18n.t("wizard.done.reachability_warning"))).not.toBeInTheDocument();
    unmount();

    const on = makeWizardState({ step: "done", configPath: "/tmp/c.toml", reachabilityWarning: true });
    render(<DoneStep {...on} />);
    expect(screen.getByText(i18n.t("wizard.done.reachability_warning"))).toBeInTheDocument();
  });

  // fix_18 (06-uat): the «Понятно» dismiss button was REMOVED — the warning is now an
  // info-only banner that stays. There must be NO dismiss button inside the warning panel.
  it("does NOT render a dismiss button — the warning is info-only (fix_18)", () => {
    const w = makeWizardState({
      step: "done",
      configPath: "/tmp/c.toml",
      reachabilityWarning: true,
    });
    render(<DoneStep {...w} />);
    // The warning text is present…
    expect(screen.getByText(i18n.t("wizard.done.reachability_warning"))).toBeInTheDocument();
    // …but there is no «Понятно»/"Got it" dismiss control anymore. The key is gone from
    // i18n; assert no button carries the old dismiss copy in either language fallback.
    expect(screen.queryByRole("button", { name: "Понятно" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Got it" })).not.toBeInTheDocument();
  });

  it("«Перейти к панели управления» stays present + enabled WHILE the warning shows (soft / non-blocking)", () => {
    const w = makeWizardState({
      step: "done",
      configPath: "/tmp/c.toml",
      reachabilityWarning: true,
    });
    render(<DoneStep {...w} />);
    const cta = screen.getByText(i18n.t("wizard.done.go_to_panel"));
    expect(cta).toBeInTheDocument();
    // The CTA's button is not disabled by the warning.
    expect(cta.closest("button")).not.toBeDisabled();
  });

  it("keeps «Перейти к панели управления» as the SINGLE primary CTA (D-03)", () => {
    const w = makeWizardState({
      step: "done",
      configPath: "/tmp/c.toml",
      vpnUsername: "swift-fox",
      vpnPassword: "Gen3ratedPass!",
    });
    const { container } = render(<DoneStep {...w} />);
    // Exactly one button renders the go_to_panel label — the single primary CTA.
    const goToPanel = screen.getAllByText(i18n.t("wizard.done.go_to_panel"));
    expect(goToPanel).toHaveLength(1);
    // UAT #20: after removing the password-reveal card, Done renders three buttons —
    // go_to_panel (primary) + go_to_connection + save_as (both secondary). The two
    // alternates are NOT additional primaries.
    expect(container.querySelectorAll("button").length).toBe(3);
  });
});
