import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { EndpointStep } from "./EndpointStep";
import { makeWizardState } from "./testHelpers";

describe("EndpointStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  // Helper: isValidEmail as a real function for tests that need it
  const validEmailFn = (e: string) =>
    !e.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

  it("renders endpoint title", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = makeWizardState({ step: "endpoint", isValidEmail: validEmailFn as any });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.title"))).toBeInTheDocument();
  });

  it("renders VPN credentials section", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = makeWizardState({ step: "endpoint", isValidEmail: validEmailFn as any });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.vpn_credentials"))).toBeInTheDocument();
  });

  it("renders vpn username input with value", () => {
    const w = makeWizardState({
      step: "endpoint",
      vpnUsername: "testuser",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    const input = screen.getByPlaceholderText("vpnuser");
    expect(input).toHaveValue("testuser");
  });

  it("calls setVpnUsername on username change", () => {
    const setVpnUsername = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      setVpnUsername,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("vpnuser"), {
      target: { value: "newuser" },
    });
    expect(setVpnUsername).toHaveBeenCalled();
  });

  it("renders vpn password input", () => {
    const w = makeWizardState({
      step: "endpoint",
      vpnPassword: "secret",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    const input = screen.getByPlaceholderText("••••••••");
    expect(input).toHaveValue("secret");
    expect(input).toHaveAttribute("type", "password");
  });

  it("toggles vpn password visibility", () => {
    const setShowVpnPassword = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      showVpnPassword: false,
      setShowVpnPassword,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    // Find the eye toggle button (it's next to the password input)
    const toggleBtns = screen.getByPlaceholderText("••••••••")
      .parentElement!.querySelectorAll("button");
    expect(toggleBtns.length).toBeGreaterThan(0);
    fireEvent.click(toggleBtns[0]);
    expect(setShowVpnPassword).toHaveBeenCalledWith(true);
  });

  // ── TLS Certificate section ──

  it("renders TLS certificate section", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = makeWizardState({ step: "endpoint", isValidEmail: validEmailFn as any });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.tls_certificate"))).toBeInTheDocument();
  });

  it("renders cert type buttons", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = makeWizardState({ step: "endpoint", isValidEmail: validEmailFn as any });
    render(<EndpointStep {...w} />);
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.endpoint.self_signed"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.endpoint.provided_cert"))).toBeInTheDocument();
  });

  it("clicking self-signed calls setCertType", () => {
    const setCertType = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      setCertType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.self_signed")));
    expect(setCertType).toHaveBeenCalledWith("selfsigned");
  });

  it("clicking provided cert calls setCertType", () => {
    const setCertType = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      setCertType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.provided_cert")));
    expect(setCertType).toHaveBeenCalledWith("provided");
  });

  it("shows self-signed warning when certType is selfsigned", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "selfsigned",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.self_signed_warning"))).toBeInTheDocument();
  });

  // ── Let's Encrypt fields ──

  it("shows domain and email fields when certType is letsencrypt", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "letsencrypt",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(screen.getByPlaceholderText("vpn.example.com")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("you@example.com")).toBeInTheDocument();
  });

  it("calls setDomain on domain input change", () => {
    const setDomain = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      certType: "letsencrypt",
      setDomain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("vpn.example.com"), {
      target: { value: "my.vpn.com" },
    });
    expect(setDomain).toHaveBeenCalled();
  });

  it("calls setEmail on email input change", () => {
    const setEmail = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      certType: "letsencrypt",
      setEmail,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "test@test.com" },
    });
    expect(setEmail).toHaveBeenCalled();
  });

  it("shows email invalid message for bad email", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "letsencrypt",
      email: "bademail",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.email_invalid"))).toBeInTheDocument();
  });

  it("shows certificate help for valid email", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "letsencrypt",
      email: "valid@test.com",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.certificate_email_help"))).toBeInTheDocument();
  });

  it("shows DNS record help with host when host is set", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "letsencrypt",
      host: "1.2.3.4",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(
      screen.getByText(i18n.t("wizard.endpoint.dns_record_help", { host: "1.2.3.4" }))
    ).toBeInTheDocument();
  });

  // ── Provided cert fields ──

  it("shows cert chain and key path fields when certType is provided", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "provided",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(screen.getByPlaceholderText("/etc/ssl/certs/cert.pem")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("/etc/ssl/private/key.pem")).toBeInTheDocument();
  });

  it("calls setCertChainPath on cert chain input change", () => {
    const setCertChainPath = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      certType: "provided",
      setCertChainPath,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("/etc/ssl/certs/cert.pem"), {
      target: { value: "/my/cert.pem" },
    });
    expect(setCertChainPath).toHaveBeenCalled();
  });

  it("calls setCertKeyPath on cert key input change", () => {
    const setCertKeyPath = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      certType: "provided",
      setCertKeyPath,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("/etc/ssl/private/key.pem"), {
      target: { value: "/my/key.pem" },
    });
    expect(setCertKeyPath).toHaveBeenCalled();
  });

  // ── Server Features (toggles) ──

  it("renders server features section", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = makeWizardState({ step: "endpoint", isValidEmail: validEmailFn as any });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.server_features"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.endpoint.feature_ping"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.endpoint.feature_speedtest"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.endpoint.feature_ipv6"))).toBeInTheDocument();
  });

  // ── Advanced settings ──

  it("renders advanced settings toggle button", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = makeWizardState({ step: "endpoint", isValidEmail: validEmailFn as any });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.advanced_settings"))).toBeInTheDocument();
  });

  it("clicking advanced settings calls setShowAdvanced", () => {
    const setShowAdvanced = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      showAdvanced: false,
      setShowAdvanced,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.advanced_settings")));
    expect(setShowAdvanced).toHaveBeenCalledWith(true);
  });

  it("shows listen address input when advanced settings are open", () => {
    const w = makeWizardState({
      step: "endpoint",
      showAdvanced: true,
      listenAddress: "0.0.0.0:443",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    const input = screen.getByPlaceholderText("0.0.0.0:443");
    expect(input).toHaveValue("0.0.0.0:443");
  });

  it("calls setListenAddress on listen address change", () => {
    const setListenAddress = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      showAdvanced: true,
      setListenAddress,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("0.0.0.0:443"), {
      target: { value: "0.0.0.0:8443" },
    });
    expect(setListenAddress).toHaveBeenCalled();
  });

  it("does not show listen address when advanced is collapsed", () => {
    const w = makeWizardState({
      step: "endpoint",
      showAdvanced: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(screen.queryByPlaceholderText("0.0.0.0:443")).not.toBeInTheDocument();
  });

  // ── DNS warning ──

  it("shows DNS warning when letsencrypt and domain is set", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "letsencrypt",
      domain: "vpn.example.com",
      host: "1.2.3.4",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(
      screen.getByText(i18n.t("wizard.endpoint.dns_warning_important"))
    ).toBeInTheDocument();
  });

  it("does not show DNS warning when domain is empty", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "letsencrypt",
      domain: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(
      screen.queryByText(i18n.t("wizard.endpoint.dns_warning_important"))
    ).not.toBeInTheDocument();
  });

  // ── Deploy / Back buttons ──

  it("deploy button calls handleDeploy", () => {
    const handleDeploy = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      handleDeploy,
      canDeploy: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.install")));
    expect(handleDeploy).toHaveBeenCalledOnce();
  });

  it("deploy button is disabled when canDeploy is false", () => {
    const w = makeWizardState({
      step: "endpoint",
      canDeploy: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    const btn = screen.getByText(i18n.t("buttons.install")).closest("button");
    expect(btn).toBeDisabled();
  });

  it("back button navigates to found when cameFromFound", () => {
    const setWizardStep = vi.fn();
    const setCameFromFound = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      cameFromFound: true,
      setWizardStep,
      setCameFromFound,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.back")));
    expect(setCameFromFound).toHaveBeenCalledWith(false);
    expect(setWizardStep).toHaveBeenCalledWith("found");
  });

  it("back button navigates to found when serverInfo.installed", () => {
    const setWizardStep = vi.fn();
    const setCameFromFound = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      cameFromFound: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverInfo: { installed: true, users: [], version: "1.0", serviceActive: true, os: "linux" } as any,
      setWizardStep,
      setCameFromFound,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.back")));
    expect(setWizardStep).toHaveBeenCalledWith("found");
  });

  it("back button navigates to server when not cameFromFound and not installed", () => {
    const setWizardStep = vi.fn();
    const setCameFromFound = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      cameFromFound: false,
      serverInfo: null,
      setWizardStep,
      setCameFromFound,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.back")));
    expect(setWizardStep).toHaveBeenCalledWith("server");
  });
});
