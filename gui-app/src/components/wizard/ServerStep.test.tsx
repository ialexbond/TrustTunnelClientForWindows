import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { ServerStep } from "./ServerStep";
import { makeWizardState } from "./testHelpers";

describe("ServerStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders title and description", () => {
    const w = makeWizardState({ step: "server" });
    render(<ServerStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.server.title"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.server.description"))).toBeInTheDocument();
  });

  it("renders host input with current value", () => {
    const w = makeWizardState({ step: "server", host: "10.0.0.1" });
    render(<ServerStep {...w} />);
    const hostInput = screen.getByPlaceholderText("123.45.67.89");
    expect(hostInput).toHaveValue("10.0.0.1");
  });

  it("calls setHost on host input change", () => {
    const setHost = vi.fn();
    const w = makeWizardState({ step: "server", setHost });
    render(<ServerStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("123.45.67.89"), {
      target: { value: "192.168.1.1" },
    });
    expect(setHost).toHaveBeenCalled();
  });

  it("renders port input with default value", () => {
    const w = makeWizardState({ step: "server", port: "22" });
    render(<ServerStep {...w} />);
    const portInput = screen.getByPlaceholderText("22");
    expect(portInput).toHaveValue("22");
  });

  it("calls setPort on port input change", () => {
    const setPort = vi.fn();
    const w = makeWizardState({ step: "server", setPort });
    render(<ServerStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("22"), {
      target: { value: "2222" },
    });
    expect(setPort).toHaveBeenCalled();
  });

  it("renders username input with default value", () => {
    const w = makeWizardState({ step: "server", sshUser: "root" });
    render(<ServerStep {...w} />);
    const userInput = screen.getByPlaceholderText("root");
    expect(userInput).toHaveValue("root");
  });

  it("calls setSshUser on username change", () => {
    const setSshUser = vi.fn();
    const w = makeWizardState({ step: "server", setSshUser });
    render(<ServerStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("root"), {
      target: { value: "admin" },
    });
    expect(setSshUser).toHaveBeenCalled();
  });

  it("renders auth mode toggle with password and key buttons", () => {
    const w = makeWizardState({ step: "server" });
    render(<ServerStep {...w} />);
    expect(screen.getByText(i18n.t("control.auth_password"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("control.auth_key"))).toBeInTheDocument();
  });

  it("shows password input by default (no sshKeyPath)", () => {
    const w = makeWizardState({ step: "server", sshKeyPath: "" });
    render(<ServerStep {...w} />);
    expect(screen.getByPlaceholderText("••••••••")).toBeInTheDocument();
  });

  it("calls setSshPassword on password change", () => {
    const setSshPassword = vi.fn();
    const w = makeWizardState({ step: "server", setSshPassword });
    render(<ServerStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("••••••••"), {
      target: { value: "secret123" },
    });
    expect(setSshPassword).toHaveBeenCalled();
  });

  it("switches to key mode when key button clicked", () => {
    const w = makeWizardState({ step: "server" });
    render(<ServerStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("control.auth_key")));
    expect(screen.getByText(i18n.t("control.select_key"))).toBeInTheDocument();
  });

  it("shows browse button in key auth mode", () => {
    const w = makeWizardState({ step: "server" });
    render(<ServerStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("control.auth_key")));
    expect(screen.getByText(i18n.t("control.browse"))).toBeInTheDocument();
  });

  it("starts in key mode when sshKeyPath is set", () => {
    const w = makeWizardState({ step: "server", sshKeyPath: "/home/user/.ssh/id_rsa" });
    render(<ServerStep {...w} />);
    expect(screen.getByText("id_rsa")).toBeInTheDocument();
  });

  it("connect button calls handleCheckServer", () => {
    const handleCheckServer = vi.fn();
    const w = makeWizardState({
      step: "server",
      handleCheckServer,
      canGoToEndpoint: true,
    });
    render(<ServerStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.server.check_connection")));
    expect(handleCheckServer).toHaveBeenCalledOnce();
  });

  it("connect button is disabled when canGoToEndpoint is false", () => {
    const w = makeWizardState({ step: "server", canGoToEndpoint: false });
    render(<ServerStep {...w} />);
    const btn = screen.getByText(i18n.t("wizard.server.check_connection")).closest("button");
    expect(btn).toBeDisabled();
  });

  it("back button calls setWizardStep with welcome and clears wizardMode", () => {
    const setWizardStep = vi.fn();
    const saveField = vi.fn();
    const w = makeWizardState({ step: "server", setWizardStep, saveField });
    render(<ServerStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.back")));
    expect(saveField).toHaveBeenCalledWith("wizardMode", "");
    expect(setWizardStep).toHaveBeenCalledWith("welcome");
  });

  it("Enter on password field triggers handleCheckServer when canGoToEndpoint", () => {
    const handleCheckServer = vi.fn();
    const w = makeWizardState({
      step: "server",
      handleCheckServer,
      canGoToEndpoint: true,
    });
    render(<ServerStep {...w} />);
    fireEvent.keyDown(screen.getByPlaceholderText("••••••••"), { key: "Enter" });
    expect(handleCheckServer).toHaveBeenCalledOnce();
  });

  it("Enter on password field does NOT trigger handleCheckServer when canGoToEndpoint is false", () => {
    const handleCheckServer = vi.fn();
    const w = makeWizardState({
      step: "server",
      handleCheckServer,
      canGoToEndpoint: false,
    });
    render(<ServerStep {...w} />);
    fireEvent.keyDown(screen.getByPlaceholderText("••••••••"), { key: "Enter" });
    expect(handleCheckServer).not.toHaveBeenCalled();
  });

  // ── SSH key auth mode ──

  it("shows key file path as full path below selector when sshKeyPath is set", () => {
    const w = makeWizardState({ step: "server", sshKeyPath: "/home/user/.ssh/id_ed25519" });
    render(<ServerStep {...w} />);
    // Full path shown below key selector
    expect(screen.getByText("/home/user/.ssh/id_ed25519")).toBeInTheDocument();
    // Filename shown in selector
    expect(screen.getByText("id_ed25519")).toBeInTheDocument();
  });

  it("shows select key placeholder when key path is empty and in key mode", () => {
    const w = makeWizardState({ step: "server", sshKeyPath: "" });
    render(<ServerStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("control.auth_key")));
    expect(screen.getByText(i18n.t("control.select_key"))).toBeInTheDocument();
  });

  it("switches back to password mode after switching to key mode", () => {
    const w = makeWizardState({ step: "server" });
    render(<ServerStep {...w} />);
    // Switch to key
    fireEvent.click(screen.getByText(i18n.t("control.auth_key")));
    expect(screen.getByText(i18n.t("control.browse"))).toBeInTheDocument();
    // Switch back to password
    fireEvent.click(screen.getByText(i18n.t("control.auth_password")));
    expect(screen.getByPlaceholderText("••••••••")).toBeInTheDocument();
  });

  // ── Key file path display ──

  it("shows key filename extracted from path with backslashes (Windows)", () => {
    const w = makeWizardState({ step: "server", sshKeyPath: "C:\\Users\\admin\\.ssh\\id_rsa" });
    render(<ServerStep {...w} />);
    expect(screen.getByText("id_rsa")).toBeInTheDocument();
  });

  // ── Port validation ──

  it("calls setPort with new value on port input change", () => {
    const setPort = vi.fn();
    const w = makeWizardState({ step: "server", setPort, port: "22" });
    render(<ServerStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("22"), { target: { value: "2222" } });
    expect(setPort).toHaveBeenCalled();
  });

  it("renders port input with custom port value", () => {
    const w = makeWizardState({ step: "server", port: "2222" });
    render(<ServerStep {...w} />);
    const portInput = screen.getByPlaceholderText("22");
    expect(portInput).toHaveValue("2222");
  });

  // ── Auth method label ──

  it("shows auth method label", () => {
    const w = makeWizardState({ step: "server" });
    render(<ServerStep {...w} />);
    expect(screen.getByText(i18n.t("control.auth_method"))).toBeInTheDocument();
  });

  // ── Key file label ──

  it("shows key file label in key mode", () => {
    const w = makeWizardState({ step: "server" });
    render(<ServerStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("control.auth_key")));
    expect(screen.getByText(i18n.t("control.key_from_file"))).toBeInTheDocument();
  });

  // ── Password label ──

  it("shows SSH password label in password mode", () => {
    const w = makeWizardState({ step: "server" });
    render(<ServerStep {...w} />);
    expect(screen.getByText(i18n.t("labels.ssh_password"))).toBeInTheDocument();
  });
});
