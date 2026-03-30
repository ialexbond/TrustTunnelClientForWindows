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

  it("shows deploy description when not in fetch mode", () => {
    const w = makeWizardState({ step: "done", isFetchMode: false });
    render(<DoneStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.done.deploy_description"))).toBeInTheDocument();
  });

  it("shows fetch description when in fetch mode", () => {
    const w = makeWizardState({ step: "done", isFetchMode: true });
    render(<DoneStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.done.fetch_description"))).toBeInTheDocument();
  });

  it("shows config path when configPath is set", () => {
    const w = makeWizardState({ step: "done", configPath: "/home/user/config.toml" });
    render(<DoneStep {...w} />);
    expect(screen.getByText("/home/user/config.toml")).toBeInTheDocument();
  });

  it("renders go-to-panel button and calls callbacks on click", () => {
    const setWizardStep = vi.fn();
    const onSetupComplete = vi.fn();
    const w = makeWizardState({ step: "done", configPath: "/tmp/c.toml", setWizardStep, onSetupComplete });
    render(<DoneStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.done.go_to_panel")));
    expect(setWizardStep).toHaveBeenCalledWith("welcome");
    expect(onSetupComplete).toHaveBeenCalledWith("/tmp/c.toml");
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

  it("renders to-home button and calls setWizardStep('welcome')", () => {
    const setWizardStep = vi.fn();
    const w = makeWizardState({ step: "done", setWizardStep });
    render(<DoneStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.done.to_home")));
    expect(setWizardStep).toHaveBeenCalledWith("welcome");
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

  // ── Back to home ──

  it("to-home button does not call onSetupComplete", () => {
    const onSetupComplete = vi.fn();
    const setWizardStep = vi.fn();
    const w = makeWizardState({ step: "done", setWizardStep, onSetupComplete });
    render(<DoneStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.done.to_home")));
    expect(setWizardStep).toHaveBeenCalledWith("welcome");
    expect(onSetupComplete).not.toHaveBeenCalled();
  });

  // ── Deploy vs fetch mode descriptions ──

  it("shows deploy description in deploy mode", () => {
    const w = makeWizardState({ step: "done", isFetchMode: false });
    render(<DoneStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.done.deploy_description"))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("wizard.done.fetch_description"))).not.toBeInTheDocument();
  });

  it("shows fetch description in fetch mode", () => {
    const w = makeWizardState({ step: "done", isFetchMode: true });
    render(<DoneStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.done.fetch_description"))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("wizard.done.deploy_description"))).not.toBeInTheDocument();
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
    expect(localStorage.getItem("tt_navigate_after_setup")).toBe("settings");
    expect(setWizardStep).toHaveBeenCalledWith("welcome");
    expect(onSetupComplete).toHaveBeenCalledWith("/tmp/c.toml");
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
});
