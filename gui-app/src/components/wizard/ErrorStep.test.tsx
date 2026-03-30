import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { ErrorStep } from "./ErrorStep";
import { makeWizardState } from "./testHelpers";

describe("ErrorStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders error title", () => {
    const w = makeWizardState({ step: "error" });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.title"))).toBeInTheDocument();
  });

  it("shows error message", () => {
    const w = makeWizardState({ step: "error", errorMessage: "Connection refused" });
    render(<ErrorStep {...w} />);
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
  });

  it("shows unknown error text when errorMessage is empty", () => {
    const w = makeWizardState({ step: "error", errorMessage: "" });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.unknown"))).toBeInTheDocument();
  });

  it("renders retry button and calls handleDeploy in deploy mode", () => {
    const handleDeploy = vi.fn();
    const w = makeWizardState({ step: "error", isFetchMode: false, handleDeploy });
    render(<ErrorStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.retry")));
    expect(handleDeploy).toHaveBeenCalledOnce();
  });

  it("renders retry button and calls handleFetchConfig in fetch mode", () => {
    const handleFetchConfig = vi.fn();
    const w = makeWizardState({ step: "error", isFetchMode: true, handleFetchConfig });
    render(<ErrorStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.retry")));
    expect(handleFetchConfig).toHaveBeenCalledOnce();
  });

  it("renders back button in deploy mode", () => {
    const setWizardStep = vi.fn();
    const w = makeWizardState({ step: "error", isFetchMode: false, setWizardStep });
    render(<ErrorStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.error.back_to_settings")));
    expect(setWizardStep).toHaveBeenCalledWith("endpoint");
  });

  it("renders back button in fetch mode", () => {
    const setWizardStep = vi.fn();
    const w = makeWizardState({ step: "error", isFetchMode: true, setWizardStep });
    render(<ErrorStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.back")));
    expect(setWizardStep).toHaveBeenCalledWith("server");
  });

  it("shows deploy logs toggle when logs exist", () => {
    const w = makeWizardState({
      step: "error",
      deployLogs: [{ message: "Step failed", level: "error" }],
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.show_logs"))).toBeInTheDocument();
  });

  it("toggles log visibility on click", () => {
    const setShowLogs = vi.fn();
    const w = makeWizardState({
      step: "error",
      deployLogs: [{ message: "Step failed", level: "error" }],
      showLogs: false,
      setShowLogs,
    });
    render(<ErrorStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.error.show_logs")));
    expect(setShowLogs).toHaveBeenCalledWith(true);
  });

  it("shows log entries when showLogs is true", () => {
    const w = makeWizardState({
      step: "error",
      deployLogs: [{ message: "Log entry text", level: "info" }],
      showLogs: true,
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText("Log entry text")).toBeInTheDocument();
  });

  it("shows reinstall prompt after 2 fetch retries", () => {
    const w = makeWizardState({
      step: "error",
      isFetchMode: true,
      fetchRetryCount: 2,
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.reinstall_prompt"))).toBeInTheDocument();
  });

  it("shows DNS hint for NXDOMAIN errors", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "NXDOMAIN lookup failed",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_dns"))).toBeInTheDocument();
  });

  // ── DNS hint from deploy logs ──

  it("shows DNS hint when deploy logs contain dns + domain", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "Deploy failed",
      deployLogs: [{ message: "DNS resolution for domain failed", level: "error" }],
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_dns"))).toBeInTheDocument();
  });

  // ── Let's Encrypt hint ──

  it("shows letsencrypt hint for certbot errors", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "certbot failed to obtain certificate",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_letsencrypt"))).toBeInTheDocument();
  });

  it("shows letsencrypt hint for Let's Encrypt errors in logs", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "",
      deployLogs: [{ message: "Let's Encrypt challenge failed", level: "error" }],
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_letsencrypt"))).toBeInTheDocument();
  });

  // ── Port 80 hint ──

  it("shows port 80 hint when error mentions port 80", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "port 80 is already in use",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_port_80"))).toBeInTheDocument();
  });

  // ── Unreachable hint ──

  it("shows unreachable hint for connection refused", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "connection refused by host",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_unreachable"))).toBeInTheDocument();
  });

  it("shows unreachable hint for connection timed out", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "connection timed out",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_unreachable"))).toBeInTheDocument();
  });

  it("shows unreachable hint for OS error 10060", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "os error 10060",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_unreachable"))).toBeInTheDocument();
  });

  // ── Auth failed hint ──

  it("shows auth hint for authentication error", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "Authentication failed",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_auth_failed"))).toBeInTheDocument();
  });

  it("shows auth hint for permission denied", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "Permission denied (publickey)",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_auth_failed"))).toBeInTheDocument();
  });

  // ── Multiple hints ──

  it("shows multiple hints when error matches several patterns", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "NXDOMAIN and port 80 blocked",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_dns"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.error.hint_port_80"))).toBeInTheDocument();
  });

  it("shows possible cause heading when hints present", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "NXDOMAIN lookup failed",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.possible_cause"))).toBeInTheDocument();
  });

  it("does not show hints section when no patterns match", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "some random error",
    });
    render(<ErrorStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.error.possible_cause"))).not.toBeInTheDocument();
  });

  // ── Reinstall prompt ──

  it("shows reinstall description with prompt", () => {
    const w = makeWizardState({
      step: "error",
      isFetchMode: true,
      fetchRetryCount: 2,
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.reinstall_description"))).toBeInTheDocument();
  });

  it("reinstall confirm button resets fetch mode and navigates to endpoint", () => {
    const setFetchRetryCount = vi.fn();
    const saveField = vi.fn();
    const setWizardStep = vi.fn();
    const w = makeWizardState({
      step: "error",
      isFetchMode: true,
      fetchRetryCount: 2,
      setFetchRetryCount,
      saveField,
      setWizardStep,
    });
    render(<ErrorStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.confirm_reinstall")));
    expect(setFetchRetryCount).toHaveBeenCalledWith(0);
    expect(saveField).toHaveBeenCalledWith("wizardMode", "");
    expect(setWizardStep).toHaveBeenCalledWith("endpoint");
  });

  it("cancel button in reinstall prompt navigates to server", () => {
    const setWizardStep = vi.fn();
    const w = makeWizardState({
      step: "error",
      isFetchMode: true,
      fetchRetryCount: 2,
      setWizardStep,
    });
    render(<ErrorStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.cancel")));
    expect(setWizardStep).toHaveBeenCalledWith("server");
  });

  // ── Retry flow after multiple failures ──

  it("does not show reinstall prompt when fetchRetryCount < 2", () => {
    const w = makeWizardState({
      step: "error",
      isFetchMode: true,
      fetchRetryCount: 1,
    });
    render(<ErrorStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.error.reinstall_prompt"))).not.toBeInTheDocument();
  });

  it("does not show reinstall prompt in deploy mode even with high retry count", () => {
    const w = makeWizardState({
      step: "error",
      isFetchMode: false,
      fetchRetryCount: 5,
    });
    render(<ErrorStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.error.reinstall_prompt"))).not.toBeInTheDocument();
  });

  // ── Logs copy button ──

  it("shows copy button in expanded logs", () => {
    const copyLogsToClipboard = vi.fn();
    const w = makeWizardState({
      step: "error",
      deployLogs: [{ message: "log line", level: "info" }],
      showLogs: true,
      copyLogsToClipboard,
    });
    render(<ErrorStep {...w} />);
    // Find the copy button by its title attribute
    const copyBtn = screen.getByTitle(i18n.t("wizard.error.copy_logs_tooltip"));
    fireEvent.click(copyBtn);
    expect(copyLogsToClipboard).toHaveBeenCalledOnce();
  });

  it("does not show logs toggle when deployLogs is empty", () => {
    const w = makeWizardState({
      step: "error",
      deployLogs: [],
    });
    render(<ErrorStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.error.show_logs"))).not.toBeInTheDocument();
  });
});
