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

  // WR-01: the VPN-password field mirrors the backend validate_vpn_password whitelist
  // (sanitize.rs:59-67) — backslash, single quote and double quote are rejected by the
  // backend as SSH-heredoc-injection defense, so the input must strip them so the field
  // can never hold a value the deploy would reject deep in the install.
  it("strips backslash, single quote and double quote from the VPN password (mirrors backend whitelist)", () => {
    const setVpnPassword = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      setVpnPassword,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("••••••••"), {
      // mix of allowed and backend-rejected chars
      target: { value: "a\\b'c\"d!e" },
    });
    // The three banned chars are removed; the rest of the whitelist survives.
    expect(setVpnPassword).toHaveBeenCalledWith("abcd!e");
  });

  it("keeps backend-allowed special characters in the VPN password", () => {
    const setVpnPassword = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      setVpnPassword,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.change(screen.getByPlaceholderText("••••••••"), {
      target: { value: "Aa1!@#$%^&*()_+-=[]{};:|,./<>?`~" },
    });
    expect(setVpnPassword).toHaveBeenCalledWith("Aa1!@#$%^&*()_+-=[]{};:|,./<>?`~");
  });

  // The shared PasswordInput owns its own show/hide state (it no longer reads the
  // external w.showVpnPassword/setShowVpnPassword). So we assert the behavior that
  // matters to the user — clicking the eye flips the field from password → text —
  // rather than the old internal setter call.
  it("toggles vpn password visibility via the ActionPasswordInput eye button", () => {
    const w = makeWizardState({
      step: "endpoint",
      vpnPassword: "secret",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    const input = screen.getByPlaceholderText("••••••••");
    expect(input).toHaveAttribute("type", "password");
    // ActionPasswordInput now also carries the Shuffle re-roll action, so target the
    // eye toggle by its accessible name (English default — the shared/ui primitive owns
    // its own aria fallbacks; the wizard does not pass i18n labels into it).
    const eyeBtn = screen.getByRole("button", { name: "Show password" });
    fireEvent.click(eyeBtn);
    expect(input).toHaveAttribute("type", "text");
  });

  // ── C-01 (06-13, D-11): credential generate/copy parity + required markers ──

  it("renders a re-roll (Shuffle) action for BOTH username and password", () => {
    const w = makeWizardState({
      step: "endpoint",
      vpnUsername: "swift-fox",
      vpnPassword: "secret",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(
      screen.getByRole("button", { name: i18n.t("common.generate_username") }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18n.t("common.generate_password") }),
    ).toBeInTheDocument();
  });

  it("re-rolling the username calls setVpnUsername with a fresh generated value", () => {
    const setVpnUsername = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      vpnUsername: "swift-fox",
      setVpnUsername,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.generate_username") }));
    expect(setVpnUsername).toHaveBeenCalledTimes(1);
    // generateUsername returns a non-empty VPN-safe string.
    expect(setVpnUsername.mock.calls[0][0]).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it("re-rolling the password calls setVpnPassword with a fresh generated value", () => {
    const setVpnPassword = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      vpnPassword: "secret",
      setVpnPassword,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.generate_password") }));
    expect(setVpnPassword).toHaveBeenCalledTimes(1);
    expect(setVpnPassword.mock.calls[0][0].length).toBeGreaterThan(0);
  });

  it("marks the username + password labels required with `*` (selfsigned shows no domain/email field)", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "selfsigned",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    // Self-signed has no domain/email inputs, so only username + password carry «*».
    const markers = screen.getAllByText("*");
    expect(markers).toHaveLength(2);
  });

  // UAT (06-uat fix 1): on the Let's Encrypt path, domain + email are install-required
  // (canDeploy gates non-empty domain + non-empty valid email), so they must ALSO carry
  // the «*» marker — four total (username, password, domain, email).
  it("marks domain + email required with `*` on the Let's Encrypt path", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "letsencrypt",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    const markers = screen.getAllByText("*");
    expect(markers).toHaveLength(4);
  });

  // ── C-02 (06-13): duplicate first-user username on the reinstall path ──

  it("shows the inline duplicate-username error AND disables install when isDuplicateVpnUsername (reinstall path)", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "selfsigned",
      vpnUsername: "swift-fox",
      vpnPassword: "secret",
      // serverInfo.users populated = reinstall-from-Found path.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverInfo: { installed: true, users: ["swift-fox"], version: "1.0", serviceActive: true, os: "linux" } as any,
      isDuplicateVpnUsername: true,
      canDeploy: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.username_taken"))).toBeInTheDocument();
    const btn = screen.getByText(i18n.t("buttons.install")).closest("button");
    expect(btn).toBeDisabled();
  });

  it("does NOT show the duplicate error on a clean install (serverInfo null / no collision)", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "selfsigned",
      vpnUsername: "swift-fox",
      vpnPassword: "secret",
      serverInfo: null,
      isDuplicateVpnUsername: false,
      canDeploy: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.endpoint.username_taken"))).not.toBeInTheDocument();
    const btn = screen.getByText(i18n.t("buttons.install")).closest("button");
    expect(btn).not.toBeDisabled();
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

  // ── «Защита сервера» install-time toggles (WIZARD-06 / D-01) ──

  it("renders the «Защита сервера» section heading", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = makeWizardState({ step: "endpoint", isValidEmail: validEmailFn as any });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.server_protection"))).toBeInTheDocument();
  });

  it("renders the Брандмауэр switch checked by default (default ON)", () => {
    const w = makeWizardState({
      step: "endpoint",
      enableFirewall: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    const sw = screen.getByRole("switch", { name: "Брандмауэр" });
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("renders the Fail2ban switch checked by default (default ON)", () => {
    const w = makeWizardState({
      step: "endpoint",
      enableFail2ban: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    const sw = screen.getByRole("switch", { name: "Fail2ban" });
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("clicking the firewall switch calls setEnableFirewall with the toggled value", () => {
    const setEnableFirewall = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      enableFirewall: true,
      setEnableFirewall,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByRole("switch", { name: "Брандмауэр" }));
    expect(setEnableFirewall).toHaveBeenCalledWith(false);
  });

  it("clicking the fail2ban switch calls setEnableFail2ban with the toggled value", () => {
    const setEnableFail2ban = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      enableFail2ban: true,
      setEnableFail2ban,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByRole("switch", { name: "Fail2ban" }));
    expect(setEnableFail2ban).toHaveBeenCalledWith(false);
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
  // 06-uat install-wizard slimming: the whole "Server Features" card (ICMP + IPv6
  // toggles) was REMOVED from the wizard. The ICMP and IPv6 features stay ON in the
  // generated vpn.toml (hard-coded in deploy.rs), but they are no longer user-facing
  // rows, so the card and its labels must be absent.

  it("does NOT render the removed Server Features card (ICMP / IPv6 hidden, feature kept ON)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = makeWizardState({ step: "endpoint", isValidEmail: validEmailFn as any });
    render(<EndpointStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.endpoint.server_features"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("wizard.endpoint.feature_icmp"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("wizard.endpoint.feature_ipv6"))).not.toBeInTheDocument();
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

  it("fresh install (cameFromFound=false) deploys with overwriteConfig=false (C-05)", () => {
    const handleDeploy = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      handleDeploy,
      canDeploy: true,
      cameFromFound: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.install")));
    expect(handleDeploy).toHaveBeenCalledWith({ overwriteConfig: false });
  });

  it("reinstall-from-Found (cameFromFound=true) deploys with overwriteConfig=true (C-05)", () => {
    // The deliberate «Переустановить» choice IS the consent to overwrite a diverging
    // vpn.toml/hosts.toml; credentials.toml is still preserved by the backend (D-02).
    const handleDeploy = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      handleDeploy,
      canDeploy: true,
      cameFromFound: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.install")));
    expect(handleDeploy).toHaveBeenCalledWith({ overwriteConfig: true });
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

  it("back button EXITS the wizard (onClose, «Выйти») when not cameFromFound and not installed — fresh install entry", () => {
    // The fresh install entry (from the Control Panel «Установить») has no in-wizard
    // server/«проверка» step before Settings, so back EXITS the wizard back to where
    // the user came from — never the old «server» connect screen.
    const setWizardStep = vi.fn();
    const setCameFromFound = vi.fn();
    const onClose = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      cameFromFound: false,
      serverInfo: null,
      setWizardStep,
      setCameFromFound,
      onClose,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("control.exit")));
    expect(onClose).toHaveBeenCalled();
    expect(setWizardStep).not.toHaveBeenCalled();
  });

  // ── D-10 (06-09): advanced server settings ──

  it("renders the auth_failure 407/405 chooser with RU labels when advanced is open", () => {
    const w = makeWizardState({
      step: "endpoint",
      showAdvanced: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.auth_failure_label"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.endpoint.auth_failure_407"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.endpoint.auth_failure_405"))).toBeInTheDocument();
  });

  it("clicking 405 calls setAuthFailureStatusCode(405)", () => {
    const setAuthFailureStatusCode = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      showAdvanced: true,
      setAuthFailureStatusCode,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.auth_failure_405")));
    expect(setAuthFailureStatusCode).toHaveBeenCalledWith(405);
  });

  it("does NOT render the removed Metrics / SOCKS5 / Allow-private settings (advanced open)", () => {
    // 06-uat install-wizard slimming: these three settings were REMOVED end-to-end. Even
    // with the «Дополнительно» disclosure open they must not appear — the disclosure now
    // only hosts listen_address + the 407/405 chooser.
    const w = makeWizardState({
      step: "endpoint",
      showAdvanced: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.endpoint.allow_private_network_label"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("wizard.endpoint.metrics_label"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("wizard.endpoint.socks5_label"))).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("127.0.0.1:1987")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("10.0.0.5:1080")).not.toBeInTheDocument();
    // The «Дополнительно» disclosure itself stays (the 407/405 chooser still lives here).
    expect(screen.getByText(i18n.t("wizard.endpoint.auth_failure_label"))).toBeInTheDocument();
  });

  it("surfaces the C-08 LE-domain inline error when leDomainError is set", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "letsencrypt",
      domain: "vpn.local",
      leDomainError: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.endpoint.le_domain_invalid"))).toBeInTheDocument();
  });
});
